import type { BaseEffectMatcherASTNode } from '@paraharness/core';

/**
 * Passive capability lease effect matcher AST node covering Stripe refunds up to `maxRefundUsd` (`stripe.allowRefundUpToUsd`).
 *
 * Embedded inside `LeaseDelta.grantedMatchers` when a human controller approves an elevated
 * refund threshold during `.onInterrupt(...).ask(...).elevateLeaseWhen(...)`.
 */
export interface StripeMaxRefundMatcherNode
  extends BaseEffectMatcherASTNode<'stripe:max-refund-matcher'> {
  /** Discriminant identifying a Stripe maximum refund lease matcher AST node. */
  readonly type: 'stripe:max-refund-matcher';
  /** Elevated maximum refund amount in USD covered by this lease matcher. */
  readonly maxRefundUsd: number;
}
