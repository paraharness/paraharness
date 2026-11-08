import type { ToolEffect } from '@metaharness/core';
import type { StripeMaxRefundMatcherNode } from '../../nodes/stripe-max-refund-matcher-node.js';

/**
 * Evaluates whether a `ToolEffect` is covered by a `StripeMaxRefundMatcherNode` capability lease.
 *
 * Returns `true` when `effect` is a `billing:effect` refund whose `amountUsd` is `<= node.maxRefundUsd`.
 *
 * @param {StripeMaxRefundMatcherNode} node   - Passive Stripe max-refund lease matcher node.
 * @param {ToolEffect}                 effect - Proposed tool effect being checked against active leases.
 *
 * @returns {boolean} True when the refund effect is within the matcher's `maxRefundUsd` ceiling.
 */
export function evaluateStripeMaxRefundMatcher(
  node: StripeMaxRefundMatcherNode,
  effect: ToolEffect,
): boolean {
  if (effect.kind !== 'billing:effect') {
    return false;
  }
  const attrs = effect.attributes;
  if (attrs === undefined || attrs['op'] !== 'refund') {
    return false;
  }
  const amountUsd = attrs['amountUsd'];
  return typeof amountUsd === 'number' && amountUsd <= node.maxRefundUsd;
}
