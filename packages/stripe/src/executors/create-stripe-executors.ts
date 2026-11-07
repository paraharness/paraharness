import type {
  PolicyGuardEvaluationInput,
  PolicyGuardEvaluationResult,
  RuntimeExecutorRegistrySlice,
  ToolEffect,
} from '@harness-dsl/core';
import type { StripeMaxRefundGuardNode } from '../nodes/stripe-max-refund-guard-node.js';
import type { StripeMaxRefundMatcherNode } from '../nodes/stripe-max-refund-matcher-node.js';
import '../nodes/stripe-registry-augmentation.js';
import { createStripeSdkGateway } from './create-stripe-sdk-gateway.js';
import { defaultStripeGateway } from './default-stripe-gateway.constants.js';
import {
  evaluateStripeMaxRefundGuard,
  evaluateStripeMaxRefundMatcher,
} from './internal/evaluate-stripe-refund-effects.js';
import { createStripeReadToolDriver } from './internal/execute-stripe-read-tool.js';
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

  return Object.freeze<RuntimeExecutorRegistrySlice>({
    tools: Object.freeze({
      'stripe:read-tool': createStripeReadToolDriver(gateway),
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
