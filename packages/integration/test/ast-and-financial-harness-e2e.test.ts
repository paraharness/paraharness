import {
  createExecutorRegistry,
  executeFlow,
  PoolManager,
  ScopeLockManager,
  ServiceSessionRegistry,
  StepContinuationQueue,
  zodToJsonSchema,
  type FlowExecutionContext,
  type HumanAdapter,
  type ModelTurnRequest,
  type ModelTurnResponse,
  type WireFrameRecord,
} from '@harness-dsl/core';
import {
  NetSuiteDraftScopeDriver,
  netsuiteExecutors,
  type NetSuiteDraftHandle,
} from '@harness-dsl/netsuite';
import { SqliteLedgerStore, sqliteExecutors } from '@harness-dsl/sqlite';
import { stripeExecutors } from '@harness-dsl/stripe';
import { describe, expect, it } from 'vitest';
import {
  appHarness,
  createEngineeringHarnessRuntime,
  createReconciliationHarnessRuntime,
  discrepancyItem,
  reconciliationFlow,
  workItem,
  type DiscrepancyItem,
} from '../src/index.js';
import { ScriptedIntegrationHumanAdapter } from './fixtures/scripted-integration-human-adapter.js';
import { ScriptedIntegrationModelDriver } from './fixtures/scripted-integration-model-driver.js';

interface CreateFinancialTestFlowContextParams {
  readonly runId: string;
  readonly currentInput: DiscrepancyItem;
  readonly modelDriver: ScriptedIntegrationModelDriver;
  readonly humanAdapter: ScriptedIntegrationHumanAdapter;
}

function assertDeepFrozen(value: unknown, seen = new Set<unknown>()): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  if ('_def' in value || value instanceof RegExp || value instanceof Date) return;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null && !Array.isArray(value)) return;
  seen.add(value);
  if (!Object.isFrozen(value)) {
    throw new Error('Expected AST container to be frozen.');
  }
  for (const key of Reflect.ownKeys(value)) {
    assertDeepFrozen(Reflect.get(value, key), seen);
  }
}

function countToolFrames(history: readonly WireFrameRecord[]): number {
  let count = 0;
  for (const frame of history) {
    if (frame.canonical.role === 'tool') {
      count += 1;
    }
  }
  return count;
}

function handleAutoReconcileTurn(
  req: ModelTurnRequest,
  turnIdx: number,
  drv: ScriptedIntegrationModelDriver,
): ModelTurnResponse {
  if (turnIdx === 0) {
    return drv.buildToolCallResponse([
      {
        id: 'call-closed-1',
        name: 'netsuite_add_journal_line',
        argsJson: JSON.stringify({
          accountId: '1010-cash',
          debitUsd: 1200.3,
          creditUsd: 0,
          postingPeriod: '2025-12',
          periodClosed: true,
        }),
      },
    ]);
  }
  if (turnIdx === 1) {
    const lastFrame = req.history[req.history.length - 1];
    const closedErr = lastFrame?.canonical.toolResults?.[0];
    expect(closedErr?.isError).toBe(true);
    expect(closedErr?.content).toContain("posting period '2025-12' is closed");

    return drv.buildToolCallResponse([
      {
        id: 'call-open-debit-a',
        name: 'netsuite_add_journal_line',
        argsJson: JSON.stringify({
          accountId: '1010-cash-a',
          debitUsd: 400.1,
          creditUsd: 0,
          postingPeriod: '2026-11',
          periodClosed: false,
        }),
      },
      {
        id: 'call-open-debit-b',
        name: 'netsuite_add_journal_line',
        argsJson: JSON.stringify({
          accountId: '1010-cash-b',
          debitUsd: 800.2,
          creditUsd: 0,
          postingPeriod: '2026-11',
          periodClosed: false,
        }),
      },
      {
        id: 'call-high-refund',
        name: 'stripe_stage_refund',
        argsJson: JSON.stringify({
          chargeId: 'ch_variance_1200_30',
          amountUsd: 1200.3,
          journalId: 'draft-je-1',
        }),
      },
      {
        id: 'call-open-credit',
        name: 'netsuite_add_journal_line',
        argsJson: JSON.stringify({
          accountId: '2010-clearing',
          debitUsd: 0,
          creditUsd: 1200.3,
          postingPeriod: '2026-11',
          periodClosed: false,
        }),
      },
    ]);
  }
  const resumedFrame = req.history[req.history.length - 1];
  const refundResult = resumedFrame?.canonical.toolResults?.find(
    (tr) => tr.callId === 'call-high-refund',
  );
  const creditResult = resumedFrame?.canonical.toolResults?.find(
    (tr) => tr.callId === 'call-open-credit',
  );
  expect(refundResult?.isError).toBe(false);
  expect(creditResult?.isError).toBe(false);

  return drv.buildStructuredResponse({
    journalEntryId: 'je-us-east-101',
    reconciledAmountUsd: 1200.3,
  });
}

function handleManualEscalationTurn(
  req: ModelTurnRequest,
  drv: ScriptedIntegrationModelDriver,
): ModelTurnResponse {
  const firstUserText = req.history[0]?.canonical.visibleText ?? '';
  expect(firstUserText).toContain(
    'Automated reconciler hit 6-turn ceiling waiting on FX settlement batch',
  );
  const toolResultsCount = countToolFrames(req.history);
  const lastVisibleText = req.history[req.history.length - 1]?.canonical.visibleText ?? '';
  if (toolResultsCount === 0) {
    return drv.buildToolCallResponse([
      {
        id: 'manual-debit',
        name: 'netsuite_add_journal_line',
        argsJson: JSON.stringify({
          accountId: '1010-cash',
          debitUsd: 450.05,
          creditUsd: 0,
          postingPeriod: '2026-11',
          periodClosed: false,
        }),
      },
      {
        id: 'manual-credit-short',
        name: 'netsuite_add_journal_line',
        argsJson: JSON.stringify({
          accountId: '2010-clearing',
          debitUsd: 0,
          creditUsd: 450.04,
          postingPeriod: '2026-11',
          periodClosed: false,
        }),
      },
    ]);
  }
  if (toolResultsCount === 1 && lastVisibleText.includes('out of balance by $0.01 USD')) {
    return drv.buildToolCallResponse([
      {
        id: 'manual-credit-cent',
        name: 'netsuite_add_journal_line',
        argsJson: JSON.stringify({
          accountId: '2010-clearing-rounding',
          debitUsd: 0,
          creditUsd: 0.01,
          postingPeriod: '2026-11',
          periodClosed: false,
        }),
      },
    ]);
  }
  return drv.buildStructuredResponse({
    journalEntryId: 'je-eu-west-manual-202',
    reconciledAmountUsd: 450.05,
  });
}

function createLimitExceededReconcileModelDriver(): ScriptedIntegrationModelDriver {
  return new ScriptedIntegrationModelDriver((req, _turnIdx, drv) => {
    if (req.toolChoice === 'none') {
      return drv.buildStructuredResponse({
        summary: 'Automated reconciler hit 6-turn ceiling waiting on FX settlement batch',
      });
    }
    const firstUserText = req.history[0]?.canonical.visibleText ?? '';
    if (firstUserText.includes('priorFailureSummary')) {
      return handleManualEscalationTurn(req, drv);
    }
    return drv.buildToolCallResponse([
      {
        id: `auto-turn-${String(req.history.length)}`,
        name: 'netsuite_add_journal_line',
        argsJson: JSON.stringify({
          accountId: '9999-unbalanced-dirty',
          debitUsd: 100,
          creditUsd: 0,
          postingPeriod: '2026-11',
          periodClosed: false,
        }),
      },
    ]);
  });
}

async function createFinancialTestFlowContext(
  params: CreateFinancialTestFlowContextParams,
): Promise<FlowExecutionContext<DiscrepancyItem, NetSuiteDraftHandle>> {
  const flowAst = reconciliationFlow.toAST();
  const registry = createExecutorRegistry(sqliteExecutors, stripeExecutors, netsuiteExecutors, {
    models: { 'claude:model': () => params.modelDriver },
    humanChannels: { 'slack:approver': () => params.humanAdapter },
  });
  if (flowAst.scope.type !== 'netsuite:draft-scope') {
    throw new Error('Expected netsuite:draft-scope');
  }
  const scopeDriver = new NetSuiteDraftScopeDriver(flowAst.scope);
  const scopeHandle = await scopeDriver.acquireRoot(params.runId);
  return {
    runId: params.runId,
    laneId: 'reconciliation-lane',
    itemKey: params.currentInput.discrepancyId,
    flow: flowAst,
    currentInput: params.currentInput,
    scopeHandle,
    scopeDriver,
    registry,
    env: {},
    ledgerStore: new SqliteLedgerStore(':memory:'),
    lockManager: new ScopeLockManager(),
    continuationQueue: new StepContinuationQueue(),
    poolManager: new PoolManager(),
    serviceRegistry: new ServiceSessionRegistry(),
    humanAdaptersById: new Map<string, HumanAdapter>([
      ['finance-controller', params.humanAdapter],
    ]),
    wirePrefixesByGroupId: new Map(),
    completedStepOutputs: new Map(),
    observedRunEffects: [],
    activeStepId: null,
    activeStepExecId: null,
    activeStepAbortController: new AbortController(),
  };
}

describe('AST purity and non-coding financial harness E2E (SPEC.md §5)', () => {
  it('compiles deeply frozen, JSON-serializable ASTs and z.toJSONSchema() wire schemas with zero build-time I/O', () => {
    const engAst = appHarness.toAST();
    const finAst = reconciliationFlow.toAST();

    expect(engAst.type).toBe('harness:root');
    expect(engAst.id).toBe('acme-engineering');
    expect(finAst.type).toBe('harness:flow');
    expect(finAst.id).toBe('reconcile-discrepancy');
    expect(finAst.scope.capabilityTier).toBe('scope');

    assertDeepFrozen(engAst);
    assertDeepFrozen(finAst);

    const workItemJsonSchema = zodToJsonSchema(workItem);
    const discrepancyJsonSchema = zodToJsonSchema(discrepancyItem);
    expect(workItemJsonSchema).toMatchObject({
      type: 'object',
      required: expect.arrayContaining(['ref', 'title', 'description']),
    });
    expect(discrepancyJsonSchema).toMatchObject({
      type: 'object',
      required: expect.arrayContaining(['discrepancyId', 'accountRegion', 'varianceUsd']),
    });

    const engJson = JSON.stringify(engAst);
    const finJson = JSON.stringify(finAst);
    expect(JSON.parse(engJson)).toMatchObject({
      type: 'harness:root',
      id: 'acme-engineering',
    });
    expect(JSON.parse(finJson)).toMatchObject({
      type: 'harness:flow',
      id: 'reconcile-discrepancy',
    });

    const engRuntime = createEngineeringHarnessRuntime({
      registry: { ledgers: { 'sqlite:ledger': () => new SqliteLedgerStore(':memory:') } },
      env: { RECONCILIATION_LEDGER_PATH: ':memory:' },
    });
    const finRuntime = createReconciliationHarnessRuntime({
      env: { RECONCILIATION_LEDGER_PATH: ':memory:' },
    });
    expect(typeof engRuntime.start).toBe('function');
    expect(typeof finRuntime.start).toBe('function');
  }, 20_000);

  it('denies closed-period NetSuite postings in-band, elevates Stripe refund lease via financeController, drains remainingCalls, and verifies exact big.js decimal balance', async () => {
    const humanAdapter = new ScriptedIntegrationHumanAdapter((req) => {
      expect(req.payload).toMatchObject({
        amountUsd: 1200.3,
      });
      return {
        approved: true,
        note: 'Approved Q4 regional settlement variance',
      };
    });
    const modelDriver = new ScriptedIntegrationModelDriver((req, turnIdx, drv) =>
      handleAutoReconcileTurn(req, turnIdx, drv),
    );
    const flowCtx = await createFinancialTestFlowContext({
      runId: 'run-fin-1',
      currentInput: {
        discrepancyId: 'disc-101',
        accountRegion: 'us-east',
        varianceUsd: 1200.3,
      },
      modelDriver,
      humanAdapter,
    });

    try {
      const result = await executeFlow(flowCtx);
      expect(result.exitState).toBe('done');
      expect(result.stepOutputs['attempt-reconcile']).toEqual({
        journalEntryId: 'je-us-east-101',
        reconciledAmountUsd: 1200.3,
      });
      expect(result.scopeReceipt).toMatchObject({
        lineCount: 3,
        netBalanceUsd: 0,
      });
      expect(humanAdapter.decisionRequests).toHaveLength(1);
    } finally {
      await flowCtx.scopeDriver.release(flowCtx.scopeHandle);
    }
  }, 20_000);

  it('flushes reconcileLimitExceeded on turn exhaustion, rolls back draft journal, replaces with manualEscalationAgent, and enforces $0.01 big.js balanceZeroCheck', async () => {
    const humanAdapter = new ScriptedIntegrationHumanAdapter(() => ({
      approved: true,
      note: 'ok',
    }));
    const modelDriver = createLimitExceededReconcileModelDriver();
    const flowCtx = await createFinancialTestFlowContext({
      runId: 'run-fin-limit-2',
      currentInput: {
        discrepancyId: 'disc-202',
        accountRegion: 'eu-west',
        varianceUsd: 450.05,
      },
      modelDriver,
      humanAdapter,
    });

    try {
      const result = await executeFlow(flowCtx);
      expect(result.exitState).toBe('done');
      expect(result.stepOutputs['attempt-reconcile']).toEqual({
        journalEntryId: 'je-eu-west-manual-202',
        reconciledAmountUsd: 450.05,
      });
      expect(result.scopeReceipt).toMatchObject({
        lineCount: 3,
        netBalanceUsd: 0,
      });
      expect(
        flowCtx.scopeHandle.entries.every((e) => e.accountId !== '9999-unbalanced-dirty'),
      ).toBe(true);
    } finally {
      await flowCtx.scopeDriver.release(flowCtx.scopeHandle);
    }
  }, 20_000);
});
