import { GLOB_METACHAR_REGEX } from './memory-protocol.constants.js';

/**
 * Determines whether a normalized POSIX path string contains any glob metacharacter or extglob syntax (§4.2).
 *
 * Checks for `*`, `?`, `[`, `]`, `{`, `}`, `!`, and extglob prefixes `@(`, `+(`, `*(`, `?(`, `!(`,
 * classifying paths without metacharacters as `specific` file or directory paths.
 *
 * @param {string} normalized - Normalized workspace-relative POSIX path or glob string.
 *
 * @returns {boolean} `true` if `normalized` contains glob syntax; `false` if it is a specific path.
 */
export function isGlobPattern(normalized: string): boolean {
  return GLOB_METACHAR_REGEX.test(normalized);
}
