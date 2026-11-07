import picomatch from 'picomatch';
import { CACHED_GLOB_OR_EXACT_MATCHERS } from './glob-matcher-cache.constants.js';

/**
 * Builds an uncached predicate matching exact normalized file paths, positive `picomatch` globs, and negated `!` globs.
 *
 * Separates positive patterns and `exactPaths` from leading `!` exclusion patterns.
 *
 * @param {readonly string[]} globs - Exact file paths or POSIX glob patterns.
 *
 * @returns {(candidatePath: string) => boolean} Synchronous predicate testing a normalized POSIX path.
 */
function buildUncachedGlobOrExactMatcher(
  globs: readonly string[],
): (candidatePath: string) => boolean {
  if (globs.length === 0) {
    return (): boolean => false;
  }
  const exactPaths = new Set<string>();
  const positiveMatchers: Array<(input: string) => boolean> = [];
  const ignoreMatchers: Array<(input: string) => boolean> = [];
  for (const rawPattern of globs) {
    const normalizedPattern = rawPattern.replace(/\\/g, '/').replace(/^\.\//, '');
    if (normalizedPattern.startsWith('!') && normalizedPattern.length > 1) {
      ignoreMatchers.push(picomatch(normalizedPattern.slice(1).replace(/^\.\//, ''), { dot: true }));
    } else {
      exactPaths.add(normalizedPattern);
      positiveMatchers.push(picomatch(normalizedPattern, { dot: true }));
    }
  }
  return (candidatePath: string): boolean => {
    const normalizedCandidate = candidatePath.replace(/\\/g, '/').replace(/^\.\//, '');
    for (const isIgnored of ignoreMatchers) {
      if (isIgnored(normalizedCandidate)) return false;
    }
    if (exactPaths.has(normalizedCandidate)) return true;
    for (const isMatch of positiveMatchers) {
      if (isMatch(normalizedCandidate)) return true;
    }
    return positiveMatchers.length === 0 && exactPaths.size === 0 && ignoreMatchers.length > 0;
  };
}

/**
 * Pre-compiles and memoizes a path matcher testing exact normalized file paths, positive `picomatch` globs, and negated `!` globs (`SPEC.md` §4.3 & `Rule 4.4`).
 *
 * Ensures literal bracketed paths (such as `app/users/[id]/page.test.tsx`) match via $O(1)$
 * `Set` lookup alongside standard POSIX glob patterns and `!` exclusions, reusing compiled matchers via `WeakMap`.
 *
 * @param {readonly string[]} globs - Exact file paths or POSIX glob patterns (including optional `!` negations).
 *
 * @returns {(candidatePath: string) => boolean} Reusable synchronous predicate testing a normalized POSIX path.
 */
export function compileGlobOrExactMatcher(
  globs: readonly string[],
): (candidatePath: string) => boolean {
  const cached = CACHED_GLOB_OR_EXACT_MATCHERS.get(globs);
  if (cached !== undefined) {
    return cached;
  }
  const compiled = buildUncachedGlobOrExactMatcher(globs);
  CACHED_GLOB_OR_EXACT_MATCHERS.set(globs, compiled);
  return compiled;
}
