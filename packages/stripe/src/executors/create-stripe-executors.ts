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
import {
  describeStripeToolEffects,
  evaluateStripeMaxRefundGuard,
  evaluateStripeMaxRefundMatcher,
} from './internal/evaluate-stripe-refund-effects.js';

/**
 * Creates a `RuntimeExecutorRegistrySlice` registering all `@harness-dsl/stripe` executors and drivers.
 *
 * Registers `tools['stripe:read-tool']`, `policyGuards['stripe:max-refund-guard']`, and
 * `effectMatchers['stripe:max-refund-matcher']`.
 *
 * @returns {RuntimeExecutorRegistrySlice} Frozen executor registry slice for `@harness-dsl/stripe`.
 */
export function createStripeExecutors(): RuntimeExecutorRegistrySlice {
  const stripeToolDriver = Object.freeze<ToolDriver<StripeReadToolNode, unknown>>({
    describeEffects(node: StripeReadToolNode, args: unknown): readonly ToolEffect[] {
      return describeStripeToolEffects(node, args);
    },
    execute(
      node: StripeReadToolNode,
      input: unknown,
      ctx: StepExecutionContext<unknown>,
    ): ToolExecutionResult {
      const parsed = node.inputSchema.parse(input);
      const effects = describeStripeToolEffects(node, parsed);
      ctx.recordEffects(effects);
      return Object.freeze<ToolExecutionResult>({
        content: JSON.stringify({
          tool: node.name,
          status: 'ok',
          input: parsed,
        }),
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
