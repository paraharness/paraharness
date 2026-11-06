import { describe, expect, it } from 'vitest';
import {
  H,
  createExecutorRegistry,
  evaluatePreFlightToolBatch,
  z,
  type CustomDomainAST,
  type EffectMatcherASTNode,
  type PolicyGuardASTNode,
  type StepExecutionContext,
  type ToolASTNode,
  type ToolEffect,
} from '@harness-dsl/core';
import {
  stripe,
  stripeExecutors,
  type StripeMaxRefundGuardNode,
  type StripeMaxRefundMatcherNode,
  type StripeReadToolNode,
} from '../src/index.js';

function createTestStepContext(): {
  readonly ctx: StepExecutionContext<unknown>;
  readonly recordedEffects: ToolEffect[];
} {
  const registry = createExecutorRegistry(stripeExecutors);
  const recordedEffects: ToolEffect[] = [];
  const ctx: StepExecutionContext<unknown> = {
    runId: 'run-stripe-1',
    stepExecId: 'step-stripe-1',
    scopeHandle: undefined,
    activePartitions: ['us-east'],
    activeLeases: [],
    observedEffects: recordedEffects,
    registry,
    resolveEnv(value) {
      return typeof value === 'string' ? value : undefined;
    },
    getRunner() {
      throw new Error('RunnerDriver not used in stripe tests.');
    },
    recordEffects(effects) {
      recordedEffects.push(...effects);
    },
  };
  return { ctx, recordedEffects };
}

describe('@harness-dsl/stripe adapter', () => {
  it('resolves CustomDomainAST namespaced keys for tool:stripe, guard:stripe, and effectMatcher:stripe', () => {
    const tools = stripe.readTools();
    const guard = stripe.maxRefundGuardUsd(500);
    const leaseDelta = stripe.allowRefundUpToUsd(10_000);
    const matcher = leaseDelta.grantedMatchers[0] as StripeMaxRefundMatcherNode;

    const toolAsDomain: ToolASTNode = tools[0] as StripeReadToolNode;
    const guardAsDomain: PolicyGuardASTNode = guard;
    const matcherAsDomain: EffectMatcherASTNode = matcher;
    const customTool: CustomDomainAST<'tool'> = tools[0] as StripeReadToolNode;
    const customGuard: CustomDomainAST<'guard'> = guard;
    const customMatcher: CustomDomainAST<'effectMatcher'> = matcher;

    expect(toolAsDomain.type).toBe('stripe:read-tool');
    expect(guardAsDomain.type).toBe('stripe:max-refund-guard');
    expect(matcherAsDomain.type).toBe('stripe:max-refund-matcher');
    expect(customTool.effectTracking).toBe('declared');
    expect(customGuard.maxRefundUsd).toBe(500);
    expect(customMatcher.maxRefundUsd).toBe(10_000);
  });

  it('emits passive StripeReadToolNode descriptors with effectTracking declared and predicts pre-flight billing effects', async () => {
    const tools = stripe.readTools();
    expect(tools).toHaveLength(2);
    expect(tools[0]?.name).toBe('stripe_list_settlements');
    expect(tools[0]?.effectTracking).toBe('declared');
    expect(tools[1]?.name).toBe('stripe_stage_refund');
    expect(tools[1]?.effectTracking).toBe('declared');

    const { ctx, recordedEffects } = createTestStepContext();
    const driver = ctx.registry.tools['stripe:read-tool'];
    if (driver === undefined || driver.describeEffects === undefined) {
      throw new Error('Expected stripe:read-tool driver with describeEffects to be registered.');
    }

    const listTool = tools[0] as StripeReadToolNode;
    const refundTool = tools[1] as StripeReadToolNode;

    const readEffects = await driver.describeEffects(
      listTool,
      { accountRegion: 'us-east', discrepancyId: 'DISC-1' },
      undefined,
    );
    expect(readEffects).toEqual([
      {
        kind: 'billing:effect',
        mutatesScope: false,
        attributes: {
          op: 'read',
          toolName: 'stripe_list_settlements',
        },
      },
    ]);

    const refundEffects = await driver.describeEffects(
      refundTool,
      { chargeId: 'ch_101', amountUsd: 1200, journalId: 'JRN-99' },
      undefined,
    );
    expect(refundEffects).toEqual([
      {
        kind: 'billing:effect',
        mutatesScope: true,
        attributes: {
          op: 'refund',
          amountUsd: 1200,
          journalId: 'JRN-99',
        },
      },
    ]);

    const execResult = await driver.execute(
      refundTool,
      { chargeId: 'ch_101', amountUsd: 300, journalId: 'JRN-100' },
      ctx,
    );
    expect(execResult.isError).toBe(false);
    expect(JSON.parse(execResult.content)).toEqual({
      tool: 'stripe_stage_refund',
      status: 'ok',
      input: { chargeId: 'ch_101', amountUsd: 300, journalId: 'JRN-100' },
    });
    expect(recordedEffects).toHaveLength(1);
  });

  it('evaluates stripe.maxRefundGuardUsd(500) pre-flight and honors stripe.allowRefundUpToUsd(10_000) LeaseDelta elevation', async () => {
    const highValueApprovalRequest = H.interrupt('high-value-approval').payload(
      z.object({ proposedJournalId: z.string(), amountUsd: z.number(), reason: z.string() }),
    );

    const policyNode = H.policy('auto-reconcile-bounds')
      .guard(stripe.maxRefundGuardUsd(500))
      .onViolation('raise-interrupt', highValueApprovalRequest, (violation) => ({
        proposedJournalId: String(violation.violatedEffects[0]?.attributes?.['journalId'] ?? 'draft'),
        amountUsd: Number(violation.violatedEffects[0]?.attributes?.['amountUsd'] ?? 0),
        reason: violation.violationSummary,
      }))
      .toAST();

    const tools = stripe.readTools();
    const refundTool = tools[1] as StripeReadToolNode;
    const toolsByName = new Map<string, ToolASTNode>([[refundTool.name, refundTool]]);
    const { ctx } = createTestStepContext();

    const withinLimitEval = await evaluatePreFlightToolBatch({
      remainingCalls: [
        {
          callId: 'call-1',
          toolName: 'stripe_stage_refund',
          argsJson: JSON.stringify({ chargeId: 'ch_1', amountUsd: 450, journalId: 'JRN-1' }),
        },
      ],
      toolsByName,
      policy: policyNode,
      activeLeases: [],
      ctx,
    });
    expect(withinLimitEval.status).toBe('allowed');

    const overLimitEval = await evaluatePreFlightToolBatch({
      remainingCalls: [
        {
          callId: 'call-2',
          toolName: 'stripe_stage_refund',
          argsJson: JSON.stringify({ chargeId: 'ch_2', amountUsd: 2500, journalId: 'JRN-2' }),
        },
      ],
      toolsByName,
      policy: policyNode,
      activeLeases: [],
      ctx,
    });
    expect(overLimitEval.status).toBe('raise-interrupt');
    expect(overLimitEval.raisedInterrupt?.id).toBe('high-value-approval');
    expect(overLimitEval.interruptPayload).toEqual({
      proposedJournalId: 'JRN-2',
      amountUsd: 2500,
      reason:
        "Stripe refund of $2500 on tool 'stripe_stage_refund' exceeds guard 'stripe:max-refund-guard:500' limit of $500.",
    });

    const elevatedLease = stripe.allowRefundUpToUsd(10_000);
    expect(elevatedLease).toEqual({
      type: 'harness:lease-delta',
      id: 'stripe:allow-refund-up-to-usd:10000',
      grantedMatchers: [
        {
          type: 'stripe:max-refund-matcher',
          id: 'stripe:max-refund-matcher:10000',
          maxRefundUsd: 10_000,
        },
      ],
    });

    const withElevatedLeaseEval = await evaluatePreFlightToolBatch({
      remainingCalls: [
        {
          callId: 'call-2',
          toolName: 'stripe_stage_refund',
          argsJson: JSON.stringify({ chargeId: 'ch_2', amountUsd: 2500, journalId: 'JRN-2' }),
        },
      ],
      toolsByName,
      policy: policyNode,
      activeLeases: [elevatedLease],
      ctx,
    });
    expect(withElevatedLeaseEval.status).toBe('allowed');

    const beyondElevatedLeaseEval = await evaluatePreFlightToolBatch({
      remainingCalls: [
        {
          callId: 'call-3',
          toolName: 'stripe_stage_refund',
          argsJson: JSON.stringify({ chargeId: 'ch_3', amountUsd: 15_000, journalId: 'JRN-3' }),
        },
      ],
      toolsByName,
      policy: policyNode,
      activeLeases: [elevatedLease],
      ctx,
    });
    expect(beyondElevatedLeaseEval.status).toBe('raise-interrupt');
  });
});
