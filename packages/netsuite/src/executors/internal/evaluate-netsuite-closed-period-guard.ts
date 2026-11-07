import type {
  PolicyGuardEvaluationInput,
  PolicyGuardEvaluationResult,
  ToolEffect,
} from '@harness-dsl/core';
import type { NetSuiteClosedPeriodGuardNode } from '../../nodes/netsuite-closed-period-guard-node.js';

/**
 * Evaluates a `NetSuiteClosedPeriodGuardNode` against proposed pre-flight `netsuite:journal-effect` descriptors.
 *
 * Rejects any proposed journal line targeting an accounting period marked `periodClosed: true`.
 *
 * @param {NetSuiteClosedPeriodGuardNode} node - Passive NetSuite closed-period policy guard AST node.
 * @param {PolicyGuardEvaluationInput} input - Proposed tool effects and active lease deltas.
 *
 * @returns {Promise<PolicyGuardEvaluationResult>} Policy guard evaluation verdict.
 */
export function evaluateNetSuiteClosedPeriodGuard(
  node: NetSuiteClosedPeriodGuardNode,
  input: PolicyGuardEvaluationInput,
): Promise<PolicyGuardEvaluationResult> {
  const violatedEffects: ToolEffect[] = [];
  for (const effect of input.proposedEffects) {
    if (effect.kind !== 'netsuite:journal-effect') {
      continue;
    }
    if (effect.attributes?.['periodClosed'] === true) {
      violatedEffects.push(effect);
    }
  }
  if (violatedEffects.length === 0) {
    return Promise.resolve(
      Object.freeze<PolicyGuardEvaluationResult>({
        allowed: true,
        violatedEffects: Object.freeze([]),
        violationSummary: '',
      }),
    );
  }
  const firstPeriod = String(violatedEffects[0]?.attributes?.['postingPeriod'] ?? 'unknown');
  return Promise.resolve(
    Object.freeze<PolicyGuardEvaluationResult>({
      allowed: false,
      violatedEffects: Object.freeze(violatedEffects),
      violationSummary: `Policy guard '${node.id}' denied tool '${input.toolName}': posting period '${firstPeriod}' is closed.`,
    }),
  );
}
