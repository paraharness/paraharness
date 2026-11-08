import type { LeaseDelta } from '@paraharness/core';
import type { StripeMaxRefundMatcherNode } from '../nodes/stripe-max-refund-matcher-node.js';
import '../nodes/stripe-registry-augmentation.js';

/**
 * Creates a JSON-serializable `LeaseDelta` elevating the allowed Stripe refund ceiling (`stripe.allowRefundUpToUsd`).
 *
 * Wraps a passive `StripeMaxRefundMatcherNode` inside `grantedMatchers` so interrupted tool
 * batches replay cleanly once a human authority approves the higher refund limit.
 *
 * @param {number} maxRefundUsd - Elevated maximum refund amount in USD granted by the lease.
 *
 * @returns {LeaseDelta} Frozen capability lease delta containing the `StripeMaxRefundMatcherNode`.
 *
 * @throws {Error} If `maxRefundUsd` is not a finite non-negative number.
 */
export function createStripeAllowRefundLeaseDelta(maxRefundUsd: number): LeaseDelta {
  if (typeof maxRefundUsd !== 'number' || !Number.isFinite(maxRefundUsd) || maxRefundUsd < 0) {
    throw new Error(
      `Invalid maxRefundUsd '${String(maxRefundUsd)}' in stripe.allowRefundUpToUsd: expected finite non-negative number.`,
    );
  }
  const matcher = Object.freeze<StripeMaxRefundMatcherNode>({
    type: 'stripe:max-refund-matcher',
    id: `stripe:max-refund-matcher:${maxRefundUsd}`,
    maxRefundUsd,
  });
  return Object.freeze<LeaseDelta>({
    type: 'harness:lease-delta',
    id: `stripe:allow-refund-up-to-usd:${maxRefundUsd}`,
    grantedMatchers: Object.freeze([matcher]),
  });
}
