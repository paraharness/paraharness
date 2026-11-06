import type { BasePolicyGuardASTNode } from '@harness-dsl/core';

/**
 * Passive policy guard AST node enforcing a maximum per-call refund ceiling in USD (`stripe.maxRefundGuardUsd`).
 *
 * Evaluates pre-flight `billing:effect` descriptors (`op: 'refund'`) and rejects or intercepts
 * refunds exceeding `maxRefundUsd` unless covered by an active `StripeMaxRefundMatcherNode` lease.
 */
export interface StripeMaxRefundGuardNode
  extends BasePolicyGuardASTNode<'stripe:max-refund-guard'> {
  /** Discriminant identifying a Stripe maximum refund policy guard AST node. */
  readonly type: 'stripe:max-refund-guard';
  /** Maximum unapproved refund amount in USD permitted by this guard. */
  readonly maxRefundUsd: number;
}
