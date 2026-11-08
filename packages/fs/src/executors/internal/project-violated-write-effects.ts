import type {
  PolicyGuardEvaluationInput,
  PolicyGuardEvaluationResult,
  ToolEffect,
} from '@metaharness/core';
import type { FsToolEffect } from '../fs-tool-effect.js';
import { compileActiveLeaseWriteMatcher } from './compile-active-lease-write-matcher.js';

/**
 * Evaluates write effects in `input.proposedEffects` against `isPathBlocked` and projects `violatedEffects` strictly to unleased violating paths.
 *
 * Filters out any path covered by `input.activeLeases` so single-guard and multi-guard evaluations report
 * only the uncovered paths that triggered the violation (`SPEC.md` §3.5 & §4.3).
 *
 * @param {PolicyGuardEvaluationInput}                       input         - Proposed tool effects and active capability leases.
 * @param {(relPath: string, effect: ToolEffect) => boolean} isPathBlocked - Predicate returning `true` when `relPath` violates the guard.
 * @param {(violatingPaths: readonly string[]) => string}    formatSummary - Formatter producing the diagnostic `violationSummary`.
 *
 * @returns {PolicyGuardEvaluationResult} Frozen policy guard evaluation result.
 */
export function projectViolatedWriteEffects(
  input: PolicyGuardEvaluationInput,
  isPathBlocked: (relPath: string, effect: ToolEffect) => boolean,
  formatSummary: (violatingPaths: readonly string[]) => string,
): PolicyGuardEvaluationResult {
  const isLeased = compileActiveLeaseWriteMatcher(input.activeLeases);
  const violatedEffects: FsToolEffect[] = [];
  const allViolatingPaths: string[] = [];
  for (const eff of input.proposedEffects) {
    if (eff.kind !== 'fs:effect' || (eff.mutatesScope !== true && eff.attributes?.['mode'] !== 'write')) continue;
    const rawPaths = eff.attributes?.['paths'];
    if (!Array.isArray(rawPaths)) continue;
    const violatingSet = new Set<string>();
    for (const rawPath of rawPaths) {
      if (typeof rawPath !== 'string') continue;
      const normPath = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
      if (!isLeased(normPath) && isPathBlocked(normPath, eff)) {
        violatingSet.add(normPath);
        allViolatingPaths.push(normPath);
      }
    }
    if (violatingSet.size === 0) continue;
    const basePaths = eff.attributes?.['existingPathsAtBaseRef'] as readonly string[] | undefined;
    const filteredBase: string[] = [];
    for (const bp of basePaths ?? []) {
      if (violatingSet.has(bp.replace(/\\/g, '/').replace(/^\.\//, ''))) filteredBase.push(bp);
    }
    const rawProposed = eff.attributes?.['proposedContent'] as Readonly<Record<string, string>> | undefined;
    const filteredProposed: Record<string, string> = {};
    for (const vp of violatingSet) {
      if (rawProposed?.[vp] !== undefined) filteredProposed[vp] = rawProposed[vp];
    }
    const existingAtBase = Array.isArray(basePaths) ? Object.freeze(filteredBase) : undefined;
    const proposed = rawProposed !== undefined ? Object.freeze(filteredProposed) : undefined;
    violatedEffects.push(
      Object.freeze<FsToolEffect>({
        kind: 'fs:effect',
        mutatesScope: true,
        attributes: Object.freeze({
          mode: 'write',
          paths: Object.freeze([...violatingSet]),
          existingPathsAtBaseRef: existingAtBase,
          proposedContent: proposed,
        }),
      }),
    );
  }
  return Object.freeze<PolicyGuardEvaluationResult>({
    allowed: violatedEffects.length === 0,
    violatedEffects: Object.freeze(violatedEffects),
    violationSummary: violatedEffects.length === 0 ? '' : formatSummary(allViolatingPaths),
  });
}
