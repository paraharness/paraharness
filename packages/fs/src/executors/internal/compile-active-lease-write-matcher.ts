import type { LeaseDelta } from '@harness-dsl/core';
import { compileGlobOrExactMatcher } from './compile-glob-or-exact-matcher.js';

/**
 * Pre-compiles a single write-mode path matcher across all `FsGlobMatcherNode` grants in `activeLeases`.
 *
 * Evaluates both exact normalized file paths and `picomatch` glob patterns across all granted matchers (`Rule 4.4`).
 *
 * @param {readonly LeaseDelta[]} activeLeases - Active capability leases granted to the actor or loop.
 *
 * @returns {(candidatePath: string) => boolean} Reusable synchronous predicate returning `true` when `candidatePath` is leased.
 */
export function compileActiveLeaseWriteMatcher(
  activeLeases: readonly LeaseDelta[],
): (candidatePath: string) => boolean {
  if (activeLeases.length === 0) return (): boolean => false;
  const leasedGlobs: string[] = [];
  for (const lease of activeLeases) {
    for (const matcher of lease.grantedMatchers) {
      if (matcher.type !== 'fs:match-globs') continue;
      if (matcher.mode !== 'write' && matcher.mode !== 'any') continue;
      for (const glob of matcher.globs) leasedGlobs.push(glob);
    }
  }
  return compileGlobOrExactMatcher(leasedGlobs);
}
