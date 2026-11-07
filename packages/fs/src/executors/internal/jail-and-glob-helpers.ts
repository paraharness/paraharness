import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';

/**
 * Extracts `rootPath` and optional `baseRef` from an opaque isolation `scopeHandle`.
 *
 * Defaults `rootPath` to `process.cwd()` when `scopeHandle` does not carry a `worktreePath`
 * string (`SPEC.md` Invariant 5 & §4.3).
 *
 * @param {unknown} scopeHandle - Active isolation scope handle or `undefined`.
 *
 * @returns {{ readonly rootPath: string; readonly baseRef: string | undefined }} Resolved root directory and optional git `baseRef`.
 */
export function extractWorktreeRootAndBaseRef(scopeHandle: unknown): {
  readonly rootPath: string;
  readonly baseRef: string | undefined;
} {
  if (typeof scopeHandle === 'object' && scopeHandle !== null) {
    const record = scopeHandle as Readonly<Record<string, unknown>>;
    const worktreePath =
      typeof record['worktreePath'] === 'string' && record['worktreePath'].trim().length > 0
        ? record['worktreePath']
        : process.cwd();
    const baseRef =
      typeof record['baseRef'] === 'string' && record['baseRef'].trim().length > 0
        ? record['baseRef']
        : undefined;
    return Object.freeze({ rootPath: worktreePath, baseRef });
  }
  return Object.freeze({ rootPath: process.cwd(), baseRef: undefined });
}

/**
 * Resolves and jails `candidatePath` strictly inside the active worktree root (`SPEC.md` §4.3).
 *
 * Resolves existing target or parent symlinks via `realpathSync`, blocks escapes outside
 * `worktreePath`, and rejects writes targeting `node_modules` directories.
 *
 * @param {unknown} scopeHandle   - Active isolation scope handle or `undefined`.
 * @param {string}  candidatePath - Raw relative or absolute path requested by a tool or source.
 * @param {boolean} isWrite       - Whether the operation mutates the filesystem.
 *
 * @returns {{ readonly normalizedRelPath: string; readonly absolutePath: string }} Normalized POSIX relative path and jailed absolute path.
 */
export function resolveJailedWorktreePath(
  scopeHandle: unknown,
  candidatePath: string,
  isWrite: boolean,
): { readonly normalizedRelPath: string; readonly absolutePath: string } {
  if (typeof candidatePath !== 'string' || candidatePath.trim().length === 0 || candidatePath.includes('\0')) {
    throw new Error(`Invalid workspace file path '${String(candidatePath)}'.`);
  }
  const { rootPath } = extractWorktreeRootAndBaseRef(scopeHandle);
  const realRoot = realpathSync(path.resolve(rootPath));
  let cursor = path.resolve(realRoot, candidatePath);
  const trailing: string[] = [];
  for (let hops = 0; !existsSync(cursor); ) {
    if (lstatSync(cursor, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
      hops += 1;
      if (hops > 40) throw new Error(`Workspace path jail violation: symlink loop on '${candidatePath}'.`);
      cursor = path.resolve(path.dirname(cursor), readlinkSync(cursor), ...trailing);
      trailing.length = 0;
      continue;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    trailing.unshift(path.basename(cursor));
    cursor = parent;
  }
  const realCandidate = path.resolve(existsSync(cursor) ? realpathSync(cursor) : cursor, ...trailing);
  const rel = path.relative(realRoot, realCandidate);
  if (rel === '..' || rel.startsWith('../') || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Workspace path jail violation: '${candidatePath}' escapes worktree '${realRoot}'.`);
  }
  const normalizedRelPath = rel.length === 0 ? '.' : rel.split(path.sep).join('/');
  if (isWrite && (normalizedRelPath === 'node_modules' || normalizedRelPath.startsWith('node_modules/') || normalizedRelPath.includes('/node_modules/') || normalizedRelPath.endsWith('/node_modules'))) {
    throw new Error(`Write denied: modifying node_modules path '${normalizedRelPath}' is forbidden.`);
  }
  return Object.freeze({ normalizedRelPath, absolutePath: realCandidate });
}

/**
 * Pre-compiles a path matcher testing exact normalized file paths, positive `picomatch` globs, and negated `!` globs (`SPEC.md` §4.3).
 *
 * Ensures literal bracketed paths (such as `app/users/[id]/page.test.tsx`) match via $O(1)$
 * `Set` lookup alongside standard POSIX glob patterns and `!` exclusions.
 *
 * @param {readonly string[]} globs - Exact file paths or POSIX glob patterns (including optional `!` negations).
 *
 * @returns {(candidatePath: string) => boolean} Reusable synchronous predicate testing a normalized POSIX path.
 */
export function compileGlobOrExactMatcher(
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
  const existing: string[] = [];
  for (const relPath of relPaths) {
    const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
    if (baseRef !== undefined && existsSync(path.join(rootPath, '.git'))) {
      try {
        execFileSync('git', ['cat-file', '-e', `${baseRef}:${normalized}`], {
          cwd: rootPath,
          stdio: 'ignore',
          env: {
            ...process.env,
            GIT_OPTIONAL_LOCKS: '0',
            GIT_CEILING_DIRECTORIES: path.dirname(rootPath),
          },
        });
        existing.push(normalized);
      } catch {
        void 0;
      }
    } else if (existsSync(path.resolve(rootPath, normalized))) {
      existing.push(normalized);
    }
  }
  return Object.freeze(existing);
}
