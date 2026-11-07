import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { extractWorktreeRootAndBaseRef } from './extract-worktree-root-and-base-ref.js';

/**
 * Tests whether a single normalized relative file path existed at `baseRef` inside `rootPath`.
 *
 * Invokes `git cat-file -e <baseRef>:<path>` when a `.git` entry and `baseRef` are present,
 * falling back to `existsSync` on disk when no git `baseRef` is configured.
 *
 * @param {string}             rootPath       - Worktree or repository root directory path.
 * @param {string | undefined} baseRef        - Optional git base commit ref.
 * @param {boolean}            hasGitMetadata - Whether `.git` exists in `rootPath`.
 * @param {string}             normalizedPath - Normalized POSIX relative file path.
 *
 * @returns {boolean} True when `normalizedPath` existed at `baseRef`.
 */
function doesSinglePathExistAtBaseRef(
  rootPath: string,
  baseRef: string | undefined,
  hasGitMetadata: boolean,
  normalizedPath: string,
): boolean {
  if (baseRef === undefined || !hasGitMetadata) {
    return existsSync(path.resolve(rootPath, normalizedPath));
  }
  try {
    execFileSync('git', ['cat-file', '-e', `${baseRef}:${normalizedPath}`], {
      cwd: rootPath,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_CEILING_DIRECTORIES: path.dirname(rootPath),
      },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks which paths in `relPaths` existed at `scopeHandle.baseRef` via `git cat-file -e <baseRef>:<path>`.
 *
 * Falls back to checking workspace file existence when `scopeHandle` does not specify a `baseRef`.
 *
 * @param {unknown}           scopeHandle - Active isolation scope handle.
 * @param {readonly string[]} relPaths    - Normalized worktree-relative POSIX file paths.
 *
 * @returns {readonly string[]} Subset of `relPaths` that existed at `baseRef`.
 */
export function checkPathsExistAtBaseRef(
  scopeHandle: unknown,
  relPaths: readonly string[],
): readonly string[] {
  const { rootPath, baseRef } = extractWorktreeRootAndBaseRef(scopeHandle);
  const hasGitMetadata = existsSync(path.join(rootPath, '.git'));
  const existing: string[] = [];
  for (const relPath of relPaths) {
    const normalizedPath = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
    if (doesSinglePathExistAtBaseRef(rootPath, baseRef, hasGitMetadata, normalizedPath)) {
      existing.push(normalizedPath);
    }
  }
  return Object.freeze(existing);
}
