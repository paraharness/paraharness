import path from 'node:path';

/**
 * Checks whether `binaryName` or its POSIX/Windows basename matches any entry in `allowedSet`.
 *
 * Compares both the full path string and `path.basename(binaryName)` against `allowedSet`.
 *
 * @param {string}              binaryName - Candidate binary name or path from a `ToolEffect`.
 * @param {ReadonlySet<string>} allowedSet - Set of allowed binary names and basenames.
 *
 * @returns {boolean} True when the binary is permitted by the allowlist.
 */
export function isBinaryInAllowlist(
  binaryName: string,
  allowedSet: ReadonlySet<string>,
): boolean {
  return allowedSet.has(binaryName) || allowedSet.has(path.basename(binaryName));
}
