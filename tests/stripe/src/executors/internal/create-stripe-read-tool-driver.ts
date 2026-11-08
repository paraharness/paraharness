import type {
  StepExecutionContext,
  ToolDriver,
  ToolEffect,
  ToolExecutionResult,
} from '@paraharness/core';
import type { StripeReadToolNode } from '../../nodes/stripe-read-tool-node.js';
import type { StripeGateway } from '../stripe-gateway.js';
import { describeStripeToolEffects } from './describe-stripe-tool-effects.js';
import { executeStripeReadTool } from './execute-stripe-read-tool.js';

/**
 * Creates a frozen `ToolDriver<StripeReadToolNode, unknown>` bound to `gateway`.
 *
 * Binds `describeStripeToolEffects` for pre-flight policy inspection and `executeStripeReadTool` for execution.
 *
 * @param {StripeGateway} gateway - Active Stripe gateway implementation.
 *
 * @returns {ToolDriver<StripeReadToolNode, unknown>} Frozen `ToolDriver` for `'stripe:read-tool'`.
 */
export function createStripeReadToolDriver(
  gateway: StripeGateway,
): ToolDriver<StripeReadToolNode, unknown> {
  return Object.freeze<ToolDriver<StripeReadToolNode, unknown>>({
    describeEffects(node: StripeReadToolNode, args: unknown): readonly ToolEffect[] {
      return describeStripeToolEffects(node, args);
    },
    execute(
      node: StripeReadToolNode,
      input: unknown,
      ctx: StepExecutionContext<unknown>,
    ): Promise<ToolExecutionResult> {
      return executeStripeReadTool({ node, input, ctx, gateway });
    },
  });
}
