import {
  CACHED_SECRET_PATTERN_LISTS,
  DEFAULT_COMPILED_SECRET_PATTERNS,
} from './secret-patterns.constants.js';

/**
 * Compiles built-in and optional custom secret regular expressions for `fs:secret-literals`.
 *
 * Returns `DEFAULT_COMPILED_SECRET_PATTERNS` when no custom patterns are supplied, and caches
 * compiled custom pattern lists in `CACHED_SECRET_PATTERN_LISTS` (`Rule 4.4`).
 *
 * @param {readonly string[] | undefined} customPatterns - Optional custom secret regex strings.
 *
 * @returns {readonly RegExp[]} Frozen array of compiled regular expressions.
 */
export function compileSecretPatterns(
  customPatterns: readonly string[] | undefined,
): readonly RegExp[] {
  if (customPatterns === undefined || customPatterns.length === 0) {
    return DEFAULT_COMPILED_SECRET_PATTERNS;
  }
  const cached = CACHED_SECRET_PATTERN_LISTS.get(customPatterns);
  if (cached !== undefined) return cached;
  const regexes: RegExp[] = [...DEFAULT_COMPILED_SECRET_PATTERNS];
  for (const custom of customPatterns) {
    regexes.push(new RegExp(custom));
  }
  const frozen = Object.freeze(regexes);
  CACHED_SECRET_PATTERN_LISTS.set(customPatterns, frozen);
  return frozen;
}
