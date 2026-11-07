import type { StripeMaxRefundGuardNode } from '../nodes/stripe-max-refund-guard-node.js';

/**
 * Compiles a passive `StripeMaxRefundGuardNode` enforcing a USD ceiling on Stripe refunds (`stripe.maxRefundGuardUsd`).
 *
 * Validates that `maxRefundUsd` is a finite non-negative number before freezing the guard AST node.
 *
 * @param {number} maxRefundUsd - Maximum refund amount in USD allowed without lease elevation.
 *
 * @returns {StripeMaxRefundGuardNode} Frozen passive Stripe maximum refund policy guard AST node.
 *
 * @throws {Error} If `maxRefundUsd` is not a finite non-negative number.
 */
export function createStripeMaxRefundGuardBuilder(
  maxRefundUsd: number,
): StripeMaxRefundGuardNode {
  if (typeof maxRefundUsd !== 'number' || !Number.isFinite(maxRefundUsd) || maxRefundUsd < 0) {
    throw new Error(
      `Invalid maxRefundUsd '${String(maxRefundUsd)}' in stripe.maxRefundGuardUsd: expected finite non-negative number.`,
    );
  }
  return Object.freeze<StripeMaxRefundGuardNode>({
    type: 'stripe:max-refund-guard',
    id: `stripe:max-refund-guard:${maxRefundUsd}`,
    maxRefundUsd,
  });
}
