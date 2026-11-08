import type { BaseToolASTNode } from '@paraharness/core';

/**
 * Passive AST node representing a Stripe billing tool (`stripe.readTools()`).
 *
 * Uses `effectTracking: 'declared'` so pre-flight `ToolDriver.describeEffects()` predicts
 * `billing:effect` descriptors before any Stripe API mutation or refund is executed.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface StripeReadToolNode<THandle = unknown>
  extends BaseToolASTNode<'stripe:read-tool', 'declared', THandle> {
  /** Discriminant identifying a Stripe billing tool AST node. */
  readonly type: 'stripe:read-tool';
  /** Static indicator that effects are declared pre-flight via `describeEffects`. */
  readonly effectTracking: 'declared';
}
