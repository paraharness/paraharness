import type { ToolEffect } from '@harness-dsl/core';
import type { StripeReadToolNode } from '../../nodes/stripe-read-tool-node.js';

/**
 * Predicts pre-flight `ToolEffect` descriptors for a `StripeReadToolNode` invocation.
 *
 * Emits a mutating `billing:effect` (`op: 'refund'`) when `args` specifies `amountUsd` or
 * `node.name === 'stripe_stage_refund'`, and a non-mutating read effect otherwise.
 *
 * @param {StripeReadToolNode} node - Passive Stripe tool AST node.
 * @param {unknown}            args - Tool call arguments supplied by the model.
 *
 * @returns {readonly ToolEffect[]} Frozen array of predicted pre-flight `ToolEffect` descriptors.
 */
export function describeStripeToolEffects(
  node: StripeReadToolNode,
  args: unknown,
): readonly ToolEffect[] {
  const record =
    typeof args === 'object' && args !== null
      ? (args as Readonly<Record<string, unknown>>)
      : {};
  const rawAmount = record['amountUsd'];
  if (typeof rawAmount === 'number' || node.name === 'stripe_stage_refund') {
    const amountUsd = typeof rawAmount === 'number' ? rawAmount : 0;
    const journalId = typeof record['journalId'] === 'string' ? record['journalId'] : 'draft';
    return Object.freeze([
      Object.freeze<ToolEffect>({
        kind: 'billing:effect',
        mutatesScope: true,
        attributes: Object.freeze({
          op: 'refund',
          amountUsd,
          journalId,
        }),
      }),
    ]);
  }
  return Object.freeze([
    Object.freeze<ToolEffect>({
      kind: 'billing:effect',
      mutatesScope: false,
      attributes: Object.freeze({
        op: 'read',
        toolName: node.name,
      }),
    }),
  ]);
}
