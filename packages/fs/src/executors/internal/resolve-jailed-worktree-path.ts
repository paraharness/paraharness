import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { extractWorktreeRootAndBaseRef } from './extract-worktree-root-and-base-ref.js';

/**
 * Resolves the canonical filesystem path for `candidatePath` under `realRoot`, following existing and dangling symlinks.
 *
 * Walks up non-existent path components while resolving any symlink hops (capped at 40 hops to prevent cycles).
 *
 * @param {string} realRoot      - Canonicalized `realpathSync` root directory of the workspace.
 * @param {string} candidatePath - Raw relative or absolute path requested by a tool or source.
 *
 * @returns {string} Canonicalized target path with all existing and dangling symlinks resolved.
 *
 * @throws {Error} If symlink resolution exceeds 40 hops.
 */
function resolveCandidateRealPath(realRoot: string, candidatePath: string): string {
  let cursor = path.resolve(realRoot, candidatePath);
  const trailing: string[] = [];
  for (let hops = 0; !existsSync(cursor); ) {
    if (lstatSync(cursor, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
      hops += 1;
      if (hops > 40) {
        throw new Error(`Workspace path jail violation: symlink loop on '${candidatePath}'.`);
      }
      cursor = path.resolve(path.dirname(cursor), readlinkSync(cursor), ...trailing);
      trailing.length = 0;
      continue;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    trailing.unshift(path.basename(cursor));
    cursor = parent;
  }
  const resolvedBase = existsSync(cursor) ? realpathSync(cursor) : cursor;
  return path.resolve(resolvedBase, ...trailing);
}

/**
 * Determines whether a `path.relative(realRoot, targetPath)` result escapes `realRoot`.
 *
 * Rejects `..`, `../...`, platform-specific `..\...`, and absolute path results.
 *
 * @param {string} relativePath - Output of `path.relative(realRoot, targetPath)`.
 *
 * @returns {boolean} True when `relativePath` points outside `realRoot`.
 */
function isRelativePathEscapingRoot(relativePath: string): boolean {
  return (
    relativePath === '..' ||
    relativePath.startsWith('../') ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  );
}

/**
 * Determines whether a normalized POSIX relative path targets a `node_modules` directory or file.
 *
 * Used to block write/edit tools from mutating `node_modules` subtrees (`SPEC.md` §4.3).
 *
 * @param {string} normalizedRelPath - Normalized POSIX worktree-relative file path.
 *
 * @returns {boolean} True when `normalizedRelPath` is inside `node_modules`.
 */
function isNodeModulesRelativePath(normalizedRelPath: string): boolean {
  return (
    normalizedRelPath === 'node_modules' ||
    normalizedRelPath.startsWith('node_modules/') ||
    normalizedRelPath.includes('/node_modules/') ||
    normalizedRelPath.endsWith('/node_modules')
  );
}

/**
 * Resolves and jails `candidatePath` strictly inside the active worktree root (`SPEC.md` §4.3).
 *
 * Resolves existing target or parent symlinks via `realpathSync`, blocks escapes outside
 * `worktreePath`, and rejects writes targeting `node_modules` directories.
 *
 * @param {unknown}          scopeHandle           - Active isolation scope handle or `undefined`.
 * @param {string}           candidatePath         - Raw relative or absolute path requested by a tool or source.
 * @param {'read' | 'write'} [accessMode='read']   - Filesystem access mode (`'read'` or `'write'`).
 *
 * @returns {{ readonly normalizedRelPath: string; readonly absolutePath: string }} Normalized POSIX relative path and jailed absolute path.
 *
 * @throws {Error} If `candidatePath` is invalid, escapes `worktreePath`, or writes to `node_modules`.
 */
export function resolveJailedWorktreePath(
  scopeHandle: unknown,
  candidatePath: string,
  accessMode: 'read' | 'write' = 'read',
): { readonly normalizedRelPath: string; readonly absolutePath: string } {
  if (
    typeof candidatePath !== 'string' ||
    candidatePath.trim().length === 0 ||
    candidatePath.includes('\0')
  ) {
    throw new Error(`Invalid workspace file path '${String(candidatePath)}'.`);
  }
  const { rootPath } = extractWorktreeRootAndBaseRef(scopeHandle);
  const realRoot = realpathSync(path.resolve(rootPath));
  const realCandidate = resolveCandidateRealPath(realRoot, candidatePath);
  const relativePath = path.relative(realRoot, realCandidate);
  if (isRelativePathEscapingRoot(relativePath)) {
    throw new Error(
      `Workspace path jail violation: '${candidatePath}' escapes worktree '${realRoot}'.`,
    );
  }
  const normalizedRelPath = relativePath.length === 0 ? '.' : relativePath.split(path.sep).join('/');
  if (accessMode === 'write' && isNodeModulesRelativePath(normalizedRelPath)) {
    throw new Error(`Write denied: modifying node_modules path '${normalizedRelPath}' is forbidden.`);
  }
  return Object.freeze({ normalizedRelPath, absolutePath: realCandidate });
}
