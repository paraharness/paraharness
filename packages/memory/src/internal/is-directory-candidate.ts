import path from 'node:path';

/**
 * Determines whether a specific non-glob path `candidate` represents a directory candidate against
 * the tracked repository file list `repoFiles` (§4.3, §5.2).
 *
 * Evaluates `!repoFiles.includes(candidate) && (repoFiles.some((f) => f.startsWith(candidate + '/')) || path.posix.extname(candidate) === '')`.
 *
 * @param {string}            candidate - Normalized specific (non-glob) POSIX path.
 * @param {readonly string[]} repoFiles - Tracked workspace-relative POSIX file paths.
 *
 * @returns {boolean} `true` if `candidate` should be treated as a directory; `false` if it is a file path.
 */
export function isDirectoryCandidate(candidate: string, repoFiles: readonly string[]): boolean {
  if (repoFiles.includes(candidate)) {
    return false;
  }
  const dirPrefix = `${candidate}/`;
  for (const repoFile of repoFiles) {
    if (repoFile.startsWith(dirPrefix)) {
      return true;
    }
  }
  return path.posix.extname(candidate) === '';
}
