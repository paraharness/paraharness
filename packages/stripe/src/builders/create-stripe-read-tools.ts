import { z } from '@harness-dsl/core';
import type { StripeReadToolNode } from '../nodes/stripe-read-tool-node.js';

/**
 * Creates the passive `StripeReadToolNode` bundle for querying settlements and staging refunds (`stripe.readTools`).
 *
 * Emits frozen `StripeReadToolNode` descriptors with `effectTracking: 'declared'` so policy
 * guards evaluate proposed `billing:effect` attributes pre-flight before execution.
 *
 * @returns {readonly StripeReadToolNode[]} Frozen tuple of Stripe settlement and refund tool AST nodes.
 */
export function createStripeReadTools(): readonly StripeReadToolNode[] {
  const listSettlementsTool = Object.freeze<StripeReadToolNode>({
    type: 'stripe:read-tool',
    name: 'stripe_list_settlements',
    description: 'Lists Stripe settlement records and balance transactions for a regional account.',
    inputSchema: z.object({
      accountRegion: z.string(),
      discrepancyId: z.string().optional(),
    }),
    effectTracking: 'declared',
  });

  const stageRefundTool = Object.freeze<StripeReadToolNode>({
    type: 'stripe:read-tool',
    name: 'stripe_stage_refund',
    description: 'Stages or issues a Stripe customer refund tied to a reconciliation journal entry.',
    inputSchema: z.object({
      chargeId: z.string(),
      amountUsd: z.number(),
      journalId: z.string().optional(),
    }),
    effectTracking: 'declared',
  });

  return Object.freeze([listSettlementsTool, stageRefundTool]);
}
