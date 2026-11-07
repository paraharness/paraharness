import type {
  PolicyGuardEvaluationInput,
  PolicyGuardEvaluationResult,
  RuntimeExecutorRegistrySlice,
  StepExecutionContext,
  ToolDriver,
  ToolEffect,
  ToolExecutionResult,
} from '@harness-dsl/core';
import type { StripeMaxRefundGuardNode } from '../nodes/stripe-max-refund-guard-node.js';
import type { StripeMaxRefundMatcherNode } from '../nodes/stripe-max-refund-matcher-node.js';
import type { StripeReadToolNode } from '../nodes/stripe-read-tool-node.js';
import '../nodes/stripe-registry-augmentation.js';
import { createStripeSdkGateway } from './create-stripe-sdk-gateway.js';
import { defaultStripeGateway } from './default-stripe-gateway.constants.js';
import {
  describeStripeToolEffects,
  evaluateStripeMaxRefundGuard,
  evaluateStripeMaxRefundMatcher,
} from './internal/evaluate-stripe-refund-effects.js';
import type { StripeGateway } from './stripe-gateway.js';
import type { StripeSdkClientLike } from './stripe-sdk-client-like.js';

/**
 * Creates a `RuntimeExecutorRegistrySlice` registering all `@harness-dsl/stripe` executors and drivers.
 *
 * Registers `tools['stripe:read-tool']`, `policyGuards['stripe:max-refund-guard']`, and
 * `effectMatchers['stripe:max-refund-matcher']`, backed by `gatewayOrClient` (or `defaultStripeGateway`).
 *
 * @param {StripeGateway | StripeSdkClientLike | string} [gatewayOrClient=defaultStripeGateway] - Stripe gateway, SDK client, or API key.
 *
 * @returns {RuntimeExecutorRegistrySlice} Frozen executor registry slice for `@harness-dsl/stripe`.
 */
export function createStripeExecutors(
  gatewayOrClient: StripeGateway | StripeSdkClientLike | string = defaultStripeGateway,
): RuntimeExecutorRegistrySlice {
  const gateway: StripeGateway =
    typeof gatewayOrClient === 'string' || 'balanceTransactions' in gatewayOrClient
      ? createStripeSdkGateway(gatewayOrClient)
      : gatewayOrClient;

  const stripeToolDriver = Object.freeze<ToolDriver<StripeReadToolNode, unknown>>({
    describeEffects(node: StripeReadToolNode, args: unknown): readonly ToolEffect[] {
      return describeStripeToolEffects(node, args);
    },
    async execute(
      node: StripeReadToolNode,
      input: unknown,
      ctx: StepExecutionContext<unknown>,
    ): Promise<ToolExecutionResult> {
      const parsed = node.inputSchema.parse(input) as Readonly<Record<string, unknown>>;
      const effects = describeStripeToolEffects(node, parsed);
      ctx.recordEffects(effects);
      const result =
        node.name === 'stripe_stage_refund'
          ? await gateway.stageRefund({
              chargeId: String(parsed['chargeId'] ?? ''),
              amountUsd: Number(parsed['amountUsd'] ?? 0),
              journalId:
                typeof parsed['journalId'] === 'string' ? parsed['journalId'] : undefined,
            })
          : await gateway.listSettlements({
              accountRegion: String(parsed['accountRegion'] ?? ''),
              discrepancyId:
                typeof parsed['discrepancyId'] === 'string'
                  ? parsed['discrepancyId']
                  : undefined,
            });
      const payload =
        result !== undefined
          ? { tool: node.name, status: 'ok', input: parsed, result }
          : { tool: node.name, status: 'ok', input: parsed };
      return Object.freeze<ToolExecutionResult>({
        content: JSON.stringify(payload),
        isError: false,
      });
    },
  });

  return Object.freeze<RuntimeExecutorRegistrySlice>({
    tools: Object.freeze({
      'stripe:read-tool': stripeToolDriver,
    }),
    policyGuards: Object.freeze({
      'stripe:max-refund-guard': (
        node: StripeMaxRefundGuardNode,
        input: PolicyGuardEvaluationInput,
      ): PolicyGuardEvaluationResult => evaluateStripeMaxRefundGuard(node, input),
    }),
    effectMatchers: Object.freeze({
      'stripe:max-refund-matcher': (
        node: StripeMaxRefundMatcherNode,
        effect: ToolEffect,
      ): boolean => evaluateStripeMaxRefundMatcher(node, effect),
    }),
  });
}
