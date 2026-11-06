import {
  createExecutorRegistry,
  evaluatePreFlightToolBatch,
  H,
  z,
  type ClaudeModelNode,
  type CustomDomainAST,
  type RuntimeDriverContext,
  type StepExecutionContext,
  type ToolASTNode,
  type ToolEffect,
} from '@harness-dsl/core';
import { describe, expect, it } from 'vitest';
import {
  netsuite,
  netsuiteExecutors,
  type NetSuiteBalanceZeroCheckNode,
  type NetSuiteClosedPeriodGuardNode,
  type NetSuiteDraftHandle,
  type NetSuiteDraftScopeNode,
  type NetSuiteJournalToolNode,
  type NetSuiteRollbackAbortHookNode,
} from '../src/index.js';

function createNetSuiteDriverContext(): RuntimeDriverContext {
  const registry = createExecutorRegistry(netsuiteExecutors);
  return {
    registry,
    resolveEnv(value) {
      return typeof value === 'string' ? value : undefined;
    },
    getRunner() {
      throw new Error('RunnerDriver not used in netsuite tests.');
    },
  };
}

function createNetSuiteStepContext(scopeHandle: NetSuiteDraftHandle): {
  readonly ctx: StepExecutionContext<unknown>;
  readonly recordedEffects: ToolEffect[];
} {
  const registry = createExecutorRegistry(netsuiteExecutors);
  const recordedEffects: ToolEffect[] = [];
  const ctx: StepExecutionContext<unknown> = {
    runId: scopeHandle.runId,
    stepExecId: 'step-netsuite-1',
    scopeHandle,
    activePartitions: ['us-east'],
    activeLeases: [],
    observedEffects: recordedEffects,
    registry,
    resolveEnv(value) {
      return typeof value === 'string' ? value : undefined;
    },
    getRunner() {
      throw new Error('RunnerDriver not used in netsuite tests.');
    },
    recordEffects(effects) {
      recordedEffects.push(...effects);
    },
  };
  return { ctx, recordedEffects };
}

describe('@harness-dsl/netsuite adapter', () => {
  it('augments CustomDomainASTRegistry with scope:netsuite, guard:netsuite, abortHook:netsuite, tool:netsuite, and check:netsuite', () => {
    const scopeNode: CustomDomainAST<'scope'> = netsuite.draftJournalScope();
    const guardNode: CustomDomainAST<'guard'> = netsuite.forbidClosedPeriodPosting();
    const abortHookNode: CustomDomainAST<'abortHook'> = netsuite.rollbackDraftJournal();
    const checkNode: CustomDomainAST<'check'> = netsuite.balanceZeroCheck();
    const tools: readonly CustomDomainAST<'tool'>[] = netsuite.journalTools();

    expect(scopeNode.type).toBe('netsuite:draft-scope');
    expect((scopeNode as NetSuiteDraftScopeNode).capabilityTier).toBe('scope');
    expect((scopeNode as NetSuiteDraftScopeNode).supportsCheckpoints).toBe(false);
    expect((scopeNode as NetSuiteDraftScopeNode).supportsBranching).toBe(false);
    expect((guardNode as NetSuiteClosedPeriodGuardNode).type).toBe('netsuite:closed-period-guard');
    expect((abortHookNode as NetSuiteRollbackAbortHookNode).type).toBe(
      'netsuite:rollback-abort-hook',
    );
    expect((checkNode as NetSuiteBalanceZeroCheckNode).type).toBe('netsuite:balance-zero-check');
    expect(tools.map((tool) => (tool as NetSuiteJournalToolNode).name)).toEqual([
      'netsuite_add_journal_line',
      'netsuite_commit_journal',
    ]);
  });

  it('executes Tier-1 IsolationScope lifecycle (acquireRoot, reattachRoot, inspect, release) and stages journal lines', async () => {
    const scopeNode = netsuite.draftJournalScope();
    const driverCtx = createNetSuiteDriverContext();
    const scopeFactory = driverCtx.registry.scopes['netsuite:draft-scope'];
    if (scopeFactory === undefined) {
      throw new Error('Expected netsuite:draft-scope factory to be registered.');
    }
    const scopeDriver = scopeFactory(scopeNode, driverCtx);

    const handle = (await scopeDriver.acquireRoot('run-fin-42')) as NetSuiteDraftHandle;
    expect(handle).toEqual({
      runId: 'run-fin-42',
      journalId: 'draft-run-fin-42',
      status: 'open',
      entries: [],
    });

    const { ctx, recordedEffects } = createNetSuiteStepContext(handle);
    const [addLineTool, commitTool] = netsuite.journalTools();
    if (addLineTool === undefined || commitTool === undefined) {
      throw new Error('Expected NetSuite journal tools.');
    }
    const toolDriver = ctx.registry.tools['netsuite:journal-tool'];
    if (toolDriver === undefined) {
      throw new Error('Expected netsuite:journal-tool driver to be registered.');
    }

    await toolDriver.execute(
      addLineTool,
      {
        accountId: '1010-CASH',
        debitUsd: 250,
        creditUsd: 0,
        postingPeriod: '2026-11',
      },
      ctx,
    );
    await toolDriver.execute(
      addLineTool,
      {
        accountId: '4000-REVENUE',
        debitUsd: 0,
        creditUsd: 250,
        postingPeriod: '2026-11',
      },
      ctx,
    );
    expect(recordedEffects).toHaveLength(2);

    const reattached = (await scopeDriver.reattachRoot('run-fin-42')) as NetSuiteDraftHandle;
    expect(reattached.entries).toHaveLength(2);

    const receipt = await scopeDriver.inspect(handle);
    expect(receipt).toEqual({
      journalId: 'draft-run-fin-42',
      runId: 'run-fin-42',
      status: 'open',
      totalDebitUsd: 250,
      totalCreditUsd: 250,
      netBalanceUsd: 0,
      lineCount: 2,
    });

    await toolDriver.execute(commitTool, { memo: 'Monthly settlement' }, ctx);
    expect(handle.status).toBe('committed');

    await scopeDriver.release(handle);
    expect(handle.status).toBe('released');
  });

  it('enforces netsuite.forbidClosedPeriodPosting(), netsuite.balanceZeroCheck(), and netsuite.rollbackDraftJournal()', async () => {
    const scopeNode = netsuite.draftJournalScope();
    const driverCtx = createNetSuiteDriverContext();
    const scopeFactory = driverCtx.registry.scopes['netsuite:draft-scope'];
    if (scopeFactory === undefined) {
      throw new Error('Expected netsuite:draft-scope factory to be registered.');
    }
    const scopeDriver = scopeFactory(scopeNode, driverCtx);
    const handle = (await scopeDriver.acquireRoot('run-fin-99')) as NetSuiteDraftHandle;
    const { ctx } = createNetSuiteStepContext(handle);

    const [addLineTool] = netsuite.journalTools();
    if (addLineTool === undefined) {
      throw new Error('Expected netsuite_add_journal_line tool.');
    }

    const policyNode = H.policy('netsuite-closed-period-policy')
      .guard(netsuite.forbidClosedPeriodPosting())
      .onViolation('deny-with-error')
      .onAbort(netsuite.rollbackDraftJournal())
      .toAST();

    const toolsByName = new Map<string, ToolASTNode>([[addLineTool.name, addLineTool]]);
    const closedPeriodEval = await evaluatePreFlightToolBatch({
      policy: policyNode,
      toolsByName,
      remainingCalls: [
        {
          callId: 'call-closed-1',
          toolName: addLineTool.name,
          argsJson: JSON.stringify({
            accountId: '1010-CASH',
            debitUsd: 100,
            creditUsd: 0,
            postingPeriod: '2025-12',
            periodClosed: true,
          }),
        },
      ],
      activeLeases: [],
      ctx,
    });

    expect(closedPeriodEval.status).toBe('denied-with-error');
    expect(closedPeriodEval.deniedErrorMessage).toBe(
      "Policy guard 'netsuite:forbid-closed-period-posting' denied tool 'netsuite_add_journal_line': posting period '2025-12' is closed.",
    );

    const toolDriver = ctx.registry.tools['netsuite:journal-tool'];
    const checkExecutor = ctx.registry.checks['netsuite:balance-zero-check'];
    const abortHookExecutor = ctx.registry.abortHooks['netsuite:rollback-abort-hook'];
    if (
      toolDriver === undefined ||
      checkExecutor === undefined ||
      abortHookExecutor === undefined
    ) {
      throw new Error('Expected NetSuite tool, check, and abortHook executors.');
    }

    await toolDriver.execute(
      addLineTool,
      {
        accountId: '1010-CASH',
        debitUsd: 175,
        creditUsd: 0,
        postingPeriod: '2026-11',
      },
      ctx,
    );

    const unbalancedResult = await checkExecutor(netsuite.balanceZeroCheck(), undefined, ctx);
    expect(unbalancedResult).toEqual({
      ok: false,
      deficits: [
        "Draft journal 'draft-run-fin-99' is out of balance by $175 USD (debits: $175, credits: $0).",
      ],
    });

    await toolDriver.execute(
      addLineTool,
      {
        accountId: '4000-REVENUE',
        debitUsd: 0,
        creditUsd: 175,
        postingPeriod: '2026-11',
      },
      ctx,
    );

    const balancedResult = await checkExecutor(netsuite.balanceZeroCheck(), undefined, ctx);
    expect(balancedResult).toEqual({
      ok: true,
      deficits: [],
    });

    const rollbackReceipt = await abortHookExecutor(
      netsuite.rollbackDraftJournal(),
      {
        handle,
        runId: 'run-fin-99',
        stepExecId: 'step-netsuite-1',
      },
      ctx,
    );
    expect(rollbackReceipt).toEqual({
      hookId: 'netsuite:rollback-draft-journal',
      journalId: 'draft-run-fin-99',
      runId: 'run-fin-99',
      stepExecId: 'step-netsuite-1',
      discardedLineCount: 2,
      status: 'rolled-back',
    });
    expect(handle.entries).toEqual([]);
  });

  it('compiles a Tier-1 financial reconciliation H.flow with netsuite.draftJournalScope() and netsuite.rollbackDraftJournal()', () => {
    const modelNode: ClaudeModelNode = {
      type: 'claude:model',
      vendor: 'anthropic',
      alias: 'opus',
      modelId: 'claude-opus-4-6',
    };
    const discrepancySchema = z.object({ discrepancyId: z.string() });
    const receiptSchema = z.object({ journalEntryId: z.string() });
    const reconcileLimitExceeded = H.interrupt('reconcile-limit-exceeded').payload(
      z.object({ summary: z.string() }),
    );
    const reconcileAgent = H.agent('reconciler')
      .model(modelNode)
      .tools(netsuite.journalTools())
      .beforeStop(netsuite.balanceZeroCheck())
      .input(discrepancySchema)
      .output(receiptSchema)
      .toAST();
    const manualAgent = H.agent('manual-reconciler')
      .model(modelNode)
      .tools(netsuite.journalTools())
      .beforeStop(netsuite.balanceZeroCheck())
      .input(discrepancySchema.extend({ priorFailureSummary: z.string() }))
      .output(receiptSchema)
      .toAST();

    const flowNode = H.flow('reconcile-discrepancy')
      .input(discrepancySchema)
      .scope(netsuite.draftJournalScope())
      .step('attempt-reconcile', reconcileAgent, ($s) =>
        $s.onInterrupt(reconcileLimitExceeded, ($limit) =>
          $limit
            .onAbort(netsuite.rollbackDraftJournal())
            .replaceWith(manualAgent, (item, payload) => ({
              ...item,
              priorFailureSummary: payload.summary,
            })),
        ),
      )
      .exit('done')
      .toAST();

    expect(flowNode.scope.type).toBe('netsuite:draft-scope');
    expect(flowNode.scope.capabilityTier).toBe('scope');
    expect(flowNode.nodes).toHaveLength(1);
    expect(flowNode.exitState).toBe('done');
  });
});
