import type {
  LeaseDelta,
  PolicyGuardEvaluationInput,
  PolicyGuardEvaluationResult,
  ToolEffect,
} from '@harness-dsl/core';
import type { StripeMaxRefundGuardNode } from '../../nodes/stripe-max-refund-guard-node.js';
import type { StripeMaxRefundMatcherNode } from '../../nodes/stripe-max-refund-matcher-node.js';
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

/**
 * Checks whether a refund `ToolEffect` is covered by any active `LeaseDelta` in `activeLeases`.
 *
 * Inspects each `StripeMaxRefundMatcherNode` in `lease.grantedMatchers` using `evaluateStripeMaxRefundMatcher`.
 *
 * @param {ToolEffect}            effect       - Refund tool effect exceeding the base guard limit.
 * @param {readonly LeaseDelta[]} activeLeases - Currently active capability leases on the actor or loop.
 *
 * @returns {boolean} True when at least one granted matcher covers `effect`.
 */
export function isRefundCoveredByActiveLeases(
  effect: ToolEffect,
  activeLeases: readonly LeaseDelta[],
): boolean {
  for (const lease of activeLeases) {
    for (const matcher of lease.grantedMatchers) {
      if (
        matcher.type === 'stripe:max-refund-matcher' &&
        evaluateStripeMaxRefundMatcher(matcher, effect)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Evaluates a `StripeMaxRefundGuardNode` against proposed pre-flight tool effects and active leases.
 *
 * Flags any `billing:effect` refund whose `amountUsd > node.maxRefundUsd` and is not covered
 * by an active `StripeMaxRefundMatcherNode` lease.
 *
 * @param {StripeMaxRefundGuardNode}   node  - Passive Stripe maximum refund policy guard AST node.
 * @param {PolicyGuardEvaluationInput} input - Tool name, proposed effects, and active leases.
 *
 * @returns {PolicyGuardEvaluationResult} Policy guard evaluation result with `allowed` and `violatedEffects`.
 */
export function evaluateStripeMaxRefundGuard(
  node: StripeMaxRefundGuardNode,
  input: PolicyGuardEvaluationInput,
): PolicyGuardEvaluationResult {
  const violatedEffects: ToolEffect[] = [];
  let maxViolatedAmount = 0;

  for (const effect of input.proposedEffects) {
    if (effect.kind !== 'billing:effect' || effect.attributes?.['op'] !== 'refund') {
      continue;
    }
    const amountUsd = effect.attributes['amountUsd'];
    if (typeof amountUsd !== 'number' || amountUsd <= node.maxRefundUsd) {
      continue;
    }
    if (isRefundCoveredByActiveLeases(effect, input.activeLeases)) {
      continue;
    }
    violatedEffects.push(effect);
    if (amountUsd > maxViolatedAmount) {
      maxViolatedAmount = amountUsd;
    }
  }

  const allowed = violatedEffects.length === 0;
  const violationSummary = allowed
    ? ''
    : `Stripe refund of $${maxViolatedAmount} on tool '${input.toolName}' exceeds guard '${node.id}' limit of $${node.maxRefundUsd}.`;

  return Object.freeze<PolicyGuardEvaluationResult>({
    allowed,
    violatedEffects: Object.freeze(violatedEffects),
    violationSummary,
  });
}
