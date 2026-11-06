import type {
  LeaseDelta,
  PolicyGuardEvaluationResult,
  ToolEffect,
} from '@harness-dsl/core';
import type { FsToolEffect } from '../fs-tool-effect.js';
import { compileGlobOrExactMatcher } from './jail-and-glob-helpers.js';
import { DEFAULT_SECRET_PATTERN_SOURCES } from './secret-patterns.constants.js';

/**
 * Checks whether `candidatePath` is unlocked for writing by any `FsGlobMatcherNode` in `activeLeases`.
 *
 * Evaluates both exact normalized file paths and `picomatch` glob patterns across all granted matchers.
 *
 * @param {string}                candidatePath - Normalized worktree-relative POSIX file path.
 * @param {readonly LeaseDelta[]} activeLeases  - Active capability leases granted to the actor or loop.
 *
 * @returns {boolean} True when at least one active lease matcher covers writing to `candidatePath`.
 */
export function isPathCoveredByActiveLeases(
  candidatePath: string,
  activeLeases: readonly LeaseDelta[],
): boolean {
  if (activeLeases.length === 0) return false;
  for (const lease of activeLeases) {
    for (const matcher of lease.grantedMatchers) {
      if (matcher.type !== 'fs:match-globs') continue;
      if (matcher.mode !== 'write' && matcher.mode !== 'any') continue;
      const isMatch = compileGlobOrExactMatcher(matcher.globs);
      if (isMatch(candidatePath)) return true;
    }
  }
  return false;
}

/**
 * Evaluates write effects in `proposedEffects` against `isPathBlocked` and projects `violatedEffects` strictly to unleased violating paths.
 *
 * Filters out any path covered by `activeLeases` so single-guard and multi-guard evaluations report
 * only the uncovered paths that triggered the violation (`SPEC.md` §3.5 & §4.3).
 *
 * @param {readonly ToolEffect[]}                            proposedEffects - Proposed tool effects to inspect.
 * @param {readonly LeaseDelta[]}                            activeLeases    - Active capability leases.
 * @param {(relPath: string, effect: ToolEffect) => boolean} isPathBlocked   - Predicate returning `true` when `relPath` violates the guard.
 * @param {(violatingPaths: readonly string[]) => string}    formatSummary   - Formatter producing the diagnostic `violationSummary`.
 *
 * @returns {PolicyGuardEvaluationResult} Frozen policy guard evaluation result.
 */
export function projectViolatedWriteEffects(
  proposedEffects: readonly ToolEffect[],
  activeLeases: readonly LeaseDelta[],
  isPathBlocked: (relPath: string, effect: ToolEffect) => boolean,
  formatSummary: (violatingPaths: readonly string[]) => string,
): PolicyGuardEvaluationResult {
  const violatedEffects: FsToolEffect[] = [];
  const allViolatingPaths: string[] = [];
  for (const eff of proposedEffects) {
    if (eff.kind !== 'fs:effect' || (eff.mutatesScope !== true && eff.attributes?.['mode'] !== 'write')) continue;
    const rawPaths = eff.attributes?.['paths'];
    if (!Array.isArray(rawPaths)) continue;
    const violatingForEffect: string[] = [];
    for (const rawPath of rawPaths) {
      if (typeof rawPath !== 'string') continue;
      const normPath = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
      if (!isPathCoveredByActiveLeases(normPath, activeLeases) && isPathBlocked(normPath, eff)) {
        violatingForEffect.push(normPath);
        allViolatingPaths.push(normPath);
      }
    }
    if (violatingForEffect.length === 0) continue;
    const basePaths = eff.attributes?.['existingPathsAtBaseRef'] as readonly string[] | undefined;
    const existingAtBase = Array.isArray(basePaths) ? Object.freeze(basePaths.filter((p) => violatingForEffect.includes(p))) : undefined;
    const proposed = eff.attributes?.['proposedContent'] as Readonly<Record<string, string>> | undefined;
    violatedEffects.push(
      Object.freeze<FsToolEffect>({
        kind: 'fs:effect',
        mutatesScope: true,
        attributes: Object.freeze({ mode: 'write', paths: Object.freeze(violatingForEffect), existingPathsAtBaseRef: existingAtBase, proposedContent: proposed }),
      }),
    );
  }
  return Object.freeze<PolicyGuardEvaluationResult>({
    allowed: violatedEffects.length === 0,
    violatedEffects: Object.freeze(violatedEffects),
    violationSummary: violatedEffects.length === 0 ? '' : formatSummary(allViolatingPaths),
  });
}

/**
 * Collects the set of normalized file paths read across `observedEffects` (`mode === 'read'`).
 *
 * Used by `fs:require-read-before-write` to verify prior read access in the session.
 *
 * @param {readonly ToolEffect[]} observedEffects - Previously observed tool effects in the session.
 *
 * @returns {ReadonlySet<string>} Set of normalized POSIX paths read so far.
 */
export function collectReadPathsFromEffects(
  observedEffects: readonly ToolEffect[],
): ReadonlySet<string> {
  const readPaths = new Set<string>();
  for (const eff of observedEffects) {
    if (eff.kind !== 'fs:effect' || eff.attributes?.['mode'] !== 'read') continue;
    const paths = eff.attributes['paths'];
    if (Array.isArray(paths)) {
      for (const p of paths) {
        if (typeof p === 'string') readPaths.add(p.replace(/\\/g, '/').replace(/^\.\//, ''));
      }
    }
  }
  return readPaths;
}

/**
 * Compiles built-in and optional custom secret regular expressions for `fs:secret-literals`.
 *
 * Combines `DEFAULT_SECRET_PATTERN_SOURCES` with any user-supplied regex source strings.
 *
 * @param {readonly string[] | undefined} customPatterns - Optional custom secret regex strings.
 *
 * @returns {readonly RegExp[]} Frozen array of compiled regular expressions.
 */
export function compileSecretPatterns(
  customPatterns: readonly string[] | undefined,
): readonly RegExp[] {
  const regexes: RegExp[] = [];
  for (const source of DEFAULT_SECRET_PATTERN_SOURCES) {
    regexes.push(new RegExp(source));
  }
  if (customPatterns !== undefined) {
    for (const custom of customPatterns) {
      regexes.push(new RegExp(custom));
    }
  }
  return Object.freeze(regexes);
}
