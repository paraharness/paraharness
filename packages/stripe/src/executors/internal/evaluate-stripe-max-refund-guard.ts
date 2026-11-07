import type {
  LeaseDelta,
  PolicyGuardEvaluationInput,
  PolicyGuardEvaluationResult,
  ToolEffect,
} from '@harness-dsl/core';
import type { StripeMaxRefundGuardNode } from '../../nodes/stripe-max-refund-guard-node.js';
import { evaluateStripeMaxRefundMatcher } from './evaluate-stripe-max-refund-matcher.js';

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
function isRefundCoveredByActiveLeases(
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
