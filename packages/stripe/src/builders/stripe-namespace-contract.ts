import type { LeaseDelta } from '@harness-dsl/core';
import type { StripeMaxRefundGuardNode } from '../nodes/stripe-max-refund-guard-node.js';
import type { StripeReadToolNode } from '../nodes/stripe-read-tool-node.js';
import '../nodes/stripe-registry-augmentation.js';

/**
 * Public DSL builder namespace for `@harness-dsl/stripe` (`stripe.*`).
 *
 * Provides declarative factories for Stripe billing tools (`stripe.readTools`),
 * pre-flight refund policy guards (`stripe.maxRefundGuardUsd`), and refund capability leases (`stripe.allowRefundUpToUsd`).
 */
export interface StripeNamespace {
  /**
   * Returns the passive `StripeReadToolNode` bundle with `effectTracking: 'declared'`.
   *
   * Exposes settlement query and refund staging tools for financial reconciliation agents.
   *
   * @returns {readonly StripeReadToolNode[]} Frozen array of Stripe tool AST nodes.
   */
  readTools(): readonly StripeReadToolNode[];

  /**
   * Creates a passive `StripeMaxRefundGuardNode` limiting unapproved refunds to `maxRefundUsd`.
   *
   * Evaluates pre-flight `billing:effect` descriptors emitted by `ToolDriver.describeEffects()`.
   *
   * @param {number} maxRefundUsd - Maximum refund amount in USD allowed without an elevated lease.
   *
   * @returns {StripeMaxRefundGuardNode} Frozen Stripe maximum refund policy guard AST node.
   */
  maxRefundGuardUsd(maxRefundUsd: number): StripeMaxRefundGuardNode;

  /**
   * Creates a `LeaseDelta` granting a `StripeMaxRefundMatcherNode` up to `maxRefundUsd`.
   *
   * Used inside `.elevateLeaseWhen(pred, () => stripe.allowRefundUpToUsd(limit))` interrupt handlers.
   *
   * @param {number} maxRefundUsd - Elevated refund limit in USD granted by the capability lease.
   *
   * @returns {LeaseDelta} Frozen capability lease delta.
   */
  allowRefundUpToUsd(maxRefundUsd: number): LeaseDelta;
}
