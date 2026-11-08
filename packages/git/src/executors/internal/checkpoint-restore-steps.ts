import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, rmdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GitWorktreeHandle } from '@paraharness/core';
import type { GitCheckpointPayload } from '../git-checkpoint-payload.js';
import { computeNodeModulesDigest, copyFileCowOrValue } from './file-digest-and-globs.js';
import {
  runGitCommand,
  updateWorktreeHandleInPlace,
  writeHarnessMeta,
} from './git-cli-runner.js';

/**
 * Step 1 of `restoreCheckpoint`: restores `<gitdir>/HEAD`, `info/exclude`, `harness-meta.json`, live index, and `.gitignore` files.
 *
 * Ensures subsequent `git status --porcelain=v2` executes under the exact `.gitignore` and `HEAD` state of `fromCheckpoint`.
 *
 * @param {GitWorktreeHandle}    handle         - Worktree handle being restored.
 * @param {GitCheckpointPayload} fromCheckpoint - Target checkpoint payload.
 * @param {ReadonlySet<string>}  treePaths      - Set of repository-relative paths present in `fromCheckpoint.treeSha`.
 *
 * @returns {Promise<void>} Resolves once metadata and `.gitignore` files are restored.
 */
export async function restoreGitdirMetadataAndGitignores(
  handle: GitWorktreeHandle,
  fromCheckpoint: GitCheckpointPayload,
  treePaths: ReadonlySet<string>,
): Promise<void> {
  await writeFile(path.join(handle.gitDirPath, 'HEAD'), fromCheckpoint.headRawContent, 'utf8');
  if (fromCheckpoint.headRawContent.startsWith('ref:')) {
    await runGitCommand({ cwd: handle.worktreePath, args: ['update-ref', 'HEAD', fromCheckpoint.headSha] });
  }
  const excludePath = path.join(handle.gitDirPath, 'info', 'exclude');
  if (fromCheckpoint.infoExcludeContent !== null) {
    await mkdir(path.dirname(excludePath), { recursive: true });
    await writeFile(excludePath, fromCheckpoint.infoExcludeContent, 'utf8');
  } else await rm(excludePath, { force: true });
  await writeHarnessMeta(handle.gitDirPath, fromCheckpoint.meta);
  updateWorktreeHandleInPlace(handle, {
    baseRef: fromCheckpoint.meta.baseRef,
    baseBranch: fromCheckpoint.meta.baseBranch,
    branchName: fromCheckpoint.meta.branchName,
    headRef: fromCheckpoint.headSha,
    unresolvedConflictPaths: Object.freeze({ ...fromCheckpoint.meta.unresolvedConflictPaths }),
  });
  const gitignorePaths: string[] = [];
  for (const relPath of treePaths) {
    if (relPath === '.gitignore' || relPath.endsWith('/.gitignore')) {
      gitignorePaths.push(relPath);
    }
  }
  if (gitignorePaths.length > 0) {
    await checkoutCheckpointTreeAndRestoreIndex(handle, fromCheckpoint, gitignorePaths);
  }
  await runGitCommand({ cwd: handle.worktreePath, args: ['read-tree', fromCheckpoint.headSha] });
  const untrackedGitignores = await runGitCommand({
    cwd: handle.worktreePath,
    args: ['ls-files', '--others', '-z', '--', '.gitignore', ':(glob)**/.gitignore', ':!node_modules/**', ':!**/node_modules/**'],
  });
  for (const rel of untrackedGitignores.stdout.split('\0')) {
    if (rel.length > 0 && !treePaths.has(rel)) {
      await rm(path.join(handle.worktreePath, rel), { force: true });
    }
  }
}

/**
 * Step 2 of `restoreCheckpoint`: unlinks paths in `symDiffPaths` absent from `preservedPaths` and clears directory collisions.
 *
 * Prunes empty parent directories up to `handle.worktreePath` after removing added files.
 *
 * @param {GitWorktreeHandle}   handle         - Worktree handle being restored.
 * @param {readonly string[]}   symDiffPaths   - Paths in the symmetric difference between checkpoint and current state.
 * @param {ReadonlySet<string>} preservedPaths - Union of paths in `fromCheckpoint.treeSha` and `oversizedUntrackedBlobs`.
 *
 * @returns {Promise<void>} Resolves once extraneous files and directory collisions are removed.
 */
export async function unlinkAddedAndDirectoryCollisions(
  handle: GitWorktreeHandle,
  symDiffPaths: readonly string[],
  preservedPaths: ReadonlySet<string>,
): Promise<void> {
  const rootAbs = path.resolve(handle.worktreePath);
  for (const relPath of symDiffPaths) {
    const absPath = path.join(handle.worktreePath, relPath);
    if (!preservedPaths.has(relPath)) {
      await rm(absPath, { recursive: true, force: true });
      let parentDir = path.dirname(path.resolve(absPath));
      while (parentDir.startsWith(rootAbs) && parentDir !== rootAbs) {
        const entries = await readdir(parentDir).catch(() => ['non-empty']);
        if (entries.length > 0) break;
        await rmdir(parentDir).catch(() => undefined);
        parentDir = path.dirname(parentDir);
      }
      continue;
    }
    const stat = await lstat(absPath).catch(() => null);
    if (stat !== null && stat.isDirectory()) {
      await rm(absPath, { recursive: true, force: true });
    }
  }
}

/**
 * Step 3 of `restoreCheckpoint`: materializes `fromCheckpoint.treeSha` via temporary index and restores live `indexTreeSha`.
 *
 * Uses `git checkout-index -f -z --stdin` for targeted `symDiff` restoration or `-f -a` when full checkout is requested.
 *
 * @param {GitWorktreeHandle}         handle             - Worktree handle being restored.
 * @param {GitCheckpointPayload}      fromCheckpoint     - Target checkpoint payload.
 * @param {readonly string[] | 'ALL'} pathsToMaterialize - Specific paths to materialize, or `'ALL'` on integrity failure.
 *
 * @returns {Promise<void>} Resolves once files and live `<gitdir>/index` are restored.
 */
export async function checkoutCheckpointTreeAndRestoreIndex(
  handle: GitWorktreeHandle,
  fromCheckpoint: GitCheckpointPayload,
  pathsToMaterialize: readonly string[] | 'ALL',
): Promise<void> {
  const tmpIndex = path.join(handle.gitDirPath, `harness-restore-idx.${process.pid}.${randomUUID()}`);
  try {
    await runGitCommand({
      cwd: handle.worktreePath,
      args: ['read-tree', fromCheckpoint.treeSha],
      env: { GIT_INDEX_FILE: tmpIndex },
    });
    if (pathsToMaterialize === 'ALL') {
      await runGitCommand({
        cwd: handle.worktreePath,
        args: ['checkout-index', '-f', '-a'],
        env: { GIT_INDEX_FILE: tmpIndex },
      });
    } else if (pathsToMaterialize.length > 0) {
      await runGitCommand({
        cwd: handle.worktreePath,
        args: ['checkout-index', '-f', '-z', '--stdin'],
        env: { GIT_INDEX_FILE: tmpIndex },
        stdin: `${pathsToMaterialize.join('\0')}\0`,
      });
    }
  } finally {
    await rm(tmpIndex, { force: true });
  }
  await runGitCommand({ cwd: handle.worktreePath, args: ['read-tree', fromCheckpoint.indexTreeSha] });
  await runGitCommand({ cwd: handle.worktreePath, args: ['update-index', '--refresh', '-q'], allowNonZeroExit: true });
}

/**
 * Restores `<worktree>/node_modules` from `<gitdir>/harness-ckpt-nm/<digest>` when `node_modules` was mutated.
 *
 * @param {GitWorktreeHandle}    handle         - Worktree handle being restored.
 * @param {GitCheckpointPayload} fromCheckpoint - Target checkpoint payload.
 *
 * @returns {Promise<void>} Resolves once `node_modules` matches `fromCheckpoint.nodeModulesDigest`.
 */
async function restoreTamperedNodeModulesFromBackup(
  handle: GitWorktreeHandle,
  fromCheckpoint: GitCheckpointPayload,
): Promise<void> {
  const currentNmDigest = await computeNodeModulesDigest(handle.worktreePath);
  if (currentNmDigest === fromCheckpoint.nodeModulesDigest) return;
  const nmTarget = path.join(handle.worktreePath, 'node_modules');
  if (fromCheckpoint.nodeModulesDigest === 'ABSENT') {
    await rm(nmTarget, { recursive: true, force: true });
    return;
  }
  const nmBackup = path.join(handle.gitDirPath, 'harness-ckpt-nm', fromCheckpoint.nodeModulesDigest);
  const backupStat = await lstat(nmBackup).catch(() => null);
  if (backupStat === null || !backupStat.isDirectory()) return;
  await rm(nmTarget, { recursive: true, force: true });
  const stack: string[] = [''];
  while (stack.length > 0) {
    const rel = stack.pop() ?? '';
    const entries = await readdir(path.join(nmBackup, rel), { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel.length === 0 ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) stack.push(childRel);
      else await copyFileCowOrValue(path.join(nmBackup, childRel), path.join(nmTarget, childRel));
    }
  }
}

/**
 * Step 4 of `restoreCheckpoint`: copies back oversized untracked blobs and restores `node_modules` if tampered with.
 *
 * Restores parent directories, original file modes, and `<gitdir>/harness-ckpt-nm` backup when `nodeModulesDigest` changed.
 *
 * @param {GitWorktreeHandle}    handle         - Worktree handle being restored.
 * @param {GitCheckpointPayload} fromCheckpoint - Target checkpoint payload.
 *
 * @returns {Promise<void>} Resolves once all spilled untracked blobs and `node_modules` files are restored.
 */
export async function restoreOversizedUntrackedBlobs(
  handle: GitWorktreeHandle,
  fromCheckpoint: GitCheckpointPayload,
): Promise<void> {
  for (const [relPath, blobRecord] of Object.entries(fromCheckpoint.oversizedUntrackedBlobs)) {
    const srcBlob = path.join(handle.gitDirPath, 'harness-ckpt-blobs', blobRecord.blobKey);
    const destPath = path.join(handle.worktreePath, relPath);
    await copyFileCowOrValue(srcBlob, destPath, blobRecord.mode);
  }
  await restoreTamperedNodeModulesFromBackup(handle, fromCheckpoint);
}
