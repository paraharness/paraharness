import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
} from 'node:fs/promises';
import path from 'node:path';
import picomatch from 'picomatch';
import {
  COMPILED_EXCLUDE_MATCHER_CACHE,
  IMPLICIT_REPO_EXCLUDE_GLOBS,
} from './git-executor.constants.js';

/**
 * Computes the `${mode}:${sha256}` digest for a worktree path using `lstat(2)` and `readlink(2)` / `readFile(2)`.
 *
 * Returns `'DELETED'` when the path does not exist on disk (`ENOENT`), and hashes symlink target strings
 * without dereferencing broken or external symlinks.
 *
 * @param {string} fullPath - Absolute filesystem path to inspect.
 *
 * @returns {Promise<string>} Formatted `${mode}:${sha256}` digest string or `'DELETED'`.
 */
export async function computePathModeAndSha256(fullPath: string): Promise<string> {
  try {
    const stat = await lstat(fullPath);
    const hash = createHash('sha256');
    if (stat.isSymbolicLink()) {
      const target = await readlink(fullPath, 'utf8');
      hash.update(target, 'utf8');
      return `120000:${hash.digest('hex')}`;
    }
    if (stat.isDirectory()) return '040000:directory';
    const content = await readFile(fullPath);
    hash.update(content);
    const gitMode = (stat.mode & 0o111) !== 0 ? '100755' : '100644';
    return `${gitMode}:${hash.digest('hex')}`;
  } catch {
    return 'DELETED';
  }
}

/**
 * Compiles a reusable predicate testing whether a repository-relative path should be excluded from checkpoints/clones.
 *
 * Always returns `false` for `.gitignore` and `**\/.gitignore` so gitignore tampering is never masked.
 *
 * @param {readonly string[] | undefined} excludeGlobs - Configured glob patterns to exclude.
 *
 * @returns {(relPath: string) => boolean} Synchronous path exclusion predicate.
 */
export function compileWorktreeExcludeMatcher(
  excludeGlobs: readonly string[] | undefined,
): (relPath: string) => boolean {
  const allGlobs: string[] = [...IMPLICIT_REPO_EXCLUDE_GLOBS, ...(excludeGlobs ?? [])];
  const cacheKey = allGlobs.join('\0');
  const cached = COMPILED_EXCLUDE_MATCHER_CACHE.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const matchers: Array<(candidate: string) => boolean> = [];
  for (const pattern of allGlobs) {
    matchers.push(picomatch(pattern, { dot: true }));
  }
  const compiled = (relPath: string): boolean => {
    const normalized = relPath.replace(/\\/g, '/').replace(/\/+$/, '');
    if (normalized === '.gitignore' || normalized.endsWith('/.gitignore')) return false;
    for (const isMatch of matchers) {
      if (isMatch(normalized)) return true;
    }
    return false;
  };
  COMPILED_EXCLUDE_MATCHER_CACHE.set(cacheKey, compiled);
  return compiled;
}

/**
 * Checks whether a relative directory path inside `node_modules` is a transient bundler or test-runner cache directory.
 *
 * Matches both top-level and nested `.cache`, `.vite`, and `.vitest` directories.
 *
 * @param {string} relDir - Forward-slash relative directory path inside `node_modules`.
 *
 * @returns {boolean} `true` when `relDir` is a transient `.cache`, `.vite`, or `.vitest` directory.
 */
function isTransientNodeModulesCacheDir(relDir: string): boolean {
  return (
    relDir === '.cache' ||
    relDir === '.vite' ||
    relDir === '.vitest' ||
    relDir.endsWith('/.cache') ||
    relDir.endsWith('/.vite') ||
    relDir.endsWith('/.vitest')
  );
}

/**
 * Computes a structural SHA-256 digest of `<worktreePath>/node_modules`.
 *
 * Walks regular files and symlinks inside `node_modules` (excluding top-level and nested `.cache`, `.vite`, and `.vitest`)
 * so `diffEffects` and `restoreCheckpoint` can detect `node_modules` tampering without performing backup I/O.
 *
 * @param {string} worktreePath - Worktree root directory path.
 *
 * @returns {Promise<string>} Hex SHA-256 digest of the `node_modules` tree, or `'ABSENT'` when not present.
 */
export async function computeNodeModulesDigest(
  worktreePath: string,
): Promise<string> {
  const nmRoot = path.join(worktreePath, 'node_modules');
  const rootStat = await lstat(nmRoot).catch(() => null);
  if (rootStat === null) return 'ABSENT';
  const hash = createHash('sha256');
  const stack: string[] = [''];
  while (stack.length > 0) {
    const relDir = stack.pop() ?? '';
    if (isTransientNodeModulesCacheDir(relDir)) continue;
    const entries = await readdir(path.join(nmRoot, relDir), { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const childRel = relDir.length === 0 ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) stack.push(childRel);
      else {
        const digest = await computePathModeAndSha256(path.join(nmRoot, childRel));
        hash.update(`${childRel}:${digest}\n`, 'utf8');
      }
    }
  }
  return hash.digest('hex');
}

/**
 * Mirrors `<worktreePath>/node_modules` into `<backupRootDir>/<digest>` via Copy-on-Write if not already backed up.
 *
 * Skips transient `.cache`, `.vite`, and `.vitest` subdirectories and short-circuits when `digest === 'ABSENT'`
 * or `<backupRootDir>/<digest>` already exists on disk.
 *
 * @param {string} worktreePath  - Worktree root directory path.
 * @param {string} digest        - Precomputed structural SHA-256 digest of `node_modules`.
 * @param {string} backupRootDir - `<gitdir>/harness-ckpt-nm` backup root directory.
 *
 * @returns {Promise<void>} Resolves once the content-addressed backup directory is populated.
 */
export async function snapshotNodeModulesForCheckpoint(
  worktreePath: string,
  digest: string,
  backupRootDir: string,
): Promise<void> {
  if (digest === 'ABSENT') return;
  const nmRoot = path.join(worktreePath, 'node_modules');
  const digestBackupDir = path.join(backupRootDir, digest);
  const exists = await lstat(digestBackupDir).then(
    () => true,
    () => false,
  );
  if (exists) return;
  const stack: string[] = [''];
  while (stack.length > 0) {
    const relDir = stack.pop() ?? '';
    if (isTransientNodeModulesCacheDir(relDir)) continue;
    const entries = await readdir(path.join(nmRoot, relDir), { withFileTypes: true });
    for (const entry of entries) {
      const childRel = relDir.length === 0 ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) stack.push(childRel);
      else {
        await copyFileCowOrValue(path.join(nmRoot, childRel), path.join(digestBackupDir, childRel));
      }
    }
  }
}

/**
 * Copies a single file or symbolic link using Copy-on-Write (`COPYFILE_FICLONE`) when supported, falling back to value copy.
 *
 * Preserves symbolic links via `readlink` + `symlink` and applies POSIX file permission bits (`mode`) for regular files.
 *
 * @param {string} srcPath  - Source file or symlink path.
 * @param {string} destPath - Destination file or symlink path.
 * @param {number} [mode]   - Optional POSIX permission mode to apply.
 *
 * @returns {Promise<void>} Resolves once the file or symlink is copied.
 */
export async function copyFileCowOrValue(
  srcPath: string,
  destPath: string,
  mode?: number,
): Promise<void> {
  await mkdir(path.dirname(destPath), { recursive: true });
  const stat = await lstat(srcPath);
  if (stat.isSymbolicLink()) {
    const linkTarget = await readlink(srcPath, 'utf8');
    await rm(destPath, { force: true });
    await symlink(linkTarget, destPath);
    return;
  }
  try {
    await copyFile(srcPath, destPath, fsConstants.COPYFILE_FICLONE);
  } catch {
    await copyFile(srcPath, destPath);
  }
  if (mode !== undefined) {
    await chmod(destPath, mode & 0o777);
  }
}
