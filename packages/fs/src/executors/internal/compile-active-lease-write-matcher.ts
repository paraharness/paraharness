import type { LeaseDelta } from '@harness-dsl/core';
import { compileGlobOrExactMatcher } from './compile-glob-or-exact-matcher.js';
import { CACHED_ACTIVE_LEASE_WRITE_MATCHERS } from './glob-matcher-cache.constants.js';

/**
 * Collects pre-compiled path matchers across all write-covering `FsGlobMatcherNode` grants in `activeLeases`.
 *
 * @param {readonly LeaseDelta[]} activeLeases - Active capability leases granted to the actor or loop.
 *
 * @returns {Array<(candidatePath: string) => boolean>} Compiled matchers for each write or `any` glob grant.
 */
function collectActiveLeaseMatchers(
  activeLeases: readonly LeaseDelta[],
): Array<(candidatePath: string) => boolean> {
  const leaseMatchers: Array<(candidatePath: string) => boolean> = [];
  for (const lease of activeLeases) {
    for (const matcher of lease.grantedMatchers) {
      if (matcher.type === 'fs:match-globs' && (matcher.mode === 'write' || matcher.mode === 'any')) {
        leaseMatchers.push(compileGlobOrExactMatcher(matcher.globs));
      }
    }
  }
  return leaseMatchers;
}

/**
 * Pre-compiles and memoizes a single write-mode path matcher across all `FsGlobMatcherNode` grants in `activeLeases`.
 *
 * Evaluates both exact normalized file paths and `picomatch` glob patterns across all granted matchers (`Rule 4.4`),
 * caching both per-matcher `matcher.globs` predicates in `CACHED_GLOB_OR_EXACT_MATCHERS` and the composed predicate
 * in `CACHED_ACTIVE_LEASE_WRITE_MATCHERS`.
 *
 * @param {readonly LeaseDelta[]} activeLeases - Active capability leases granted to the actor or loop.
 *
 * @returns {(candidatePath: string) => boolean} Reusable synchronous predicate returning `true` when `candidatePath` is leased.
 */
export function compileActiveLeaseWriteMatcher(
  activeLeases: readonly LeaseDelta[],
): (candidatePath: string) => boolean {
  const cached = CACHED_ACTIVE_LEASE_WRITE_MATCHERS.get(activeLeases);
  if (cached !== undefined) {
    return cached;
  }
  const leaseMatchers = collectActiveLeaseMatchers(activeLeases);
  const compiled =
    leaseMatchers.length === 0
      ? (): boolean => false
      : (candidatePath: string): boolean => {
          for (const isMatch of leaseMatchers) {
            if (isMatch(candidatePath)) return true;
          }
          return false;
        };
  CACHED_ACTIVE_LEASE_WRITE_MATCHERS.set(activeLeases, compiled);
  return compiled;
}
