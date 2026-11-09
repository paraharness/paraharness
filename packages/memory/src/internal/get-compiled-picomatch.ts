import picomatch from 'picomatch';
import { PICOMATCH_MATCHER_CACHE } from './memory-protocol.constants.js';

/**
 * Returns a cached, pre-compiled `picomatch` matcher (`{ dot: true }`) for `globPattern`.
 *
 * Compiles each unique `globPattern` at most once per process in compliance with `Rule 4.4`.
 *
 * @param {string} globPattern - Normalized POSIX glob pattern to compile.
 *
 * @returns {(candidatePath: string) => boolean} Compiled predicate returning `true` when `candidatePath` matches `globPattern`.
 */
export function getCompiledPicomatch(globPattern: string): (candidatePath: string) => boolean {
  const existing = PICOMATCH_MATCHER_CACHE.get(globPattern);
  if (existing !== undefined) return existing;
  const compiled = picomatch(globPattern, { dot: true });
  PICOMATCH_MATCHER_CACHE.set(globPattern, compiled);
  return compiled;
}
