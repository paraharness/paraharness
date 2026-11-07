import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  GitCowWorktreeNode,
  GitWorktreeHandle,
  ToolEffect,
} from '@harness-dsl/core';
import type { GitCheckpointPayload } from '../git-checkpoint-payload.js';
import {
  checkoutCheckpointTreeAndRestoreIndex,
  restoreGitdirMetadataAndGitignores,
  restoreOversizedUntrackedBlobs,
  unlinkAddedAndDirectoryCollisions,
} from './checkpoint-restore-steps.js';
import {
  computeSymmetricStatusDiff,
  listTreePaths,
  stageCheckpointTreeAndOversizedBlobs,
  verifyWorktreeLocalGitIntegrity,
} from './checkpoint-staging-and-integrity.js';
import type { ComputeWorktreeStatusOptions } from './compute-worktree-status-options.js';
import { computeNodeModulesDigest } from './file-digest-and-globs.js';
import { readHarnessMeta, runGitCommand } from './git-cli-runner.js';
import { DEFAULT_MAX_UNTRACKED_FILE_SIZE_BYTES } from './git-executor.constants.js';
import {
  buildFsDiffToolEffects,
  hasGitignoreChanged,
  parsePorcelainV2Records,
} from './porcelain-v2-parser.js';
import type { WorktreeStatusSnapshot } from './worktree-status-snapshot.js';

/**
 * Computes the porcelain v2 status snapshot for `worktreePath` (`git status --porcelain=v2 -z --no-renames --untracked-files=all`).
 *
 * Optionally enables `--ignored=matching` when scanning for files hidden behind a `.gitignore` mutation.
 *
 * @param {string}                       worktreePath - Worktree directory path to scan.
 * @param {ComputeWorktreeStatusOptions} [options]    - Optional exclusion globs and ignored-matching flags.
 *
 * @returns {Promise<WorktreeStatusSnapshot>} Structured status map, untracked set, deleted set, and ignored paths.
 */
export async function computeWorktreeStatusMap(
  worktreePath: string,
  options?: ComputeWorktreeStatusOptions,
): Promise<WorktreeStatusSnapshot> {
  const args = ['status', '--porcelain=v2', '-z', '--no-renames', '--untracked-files=all'];
  if (options?.includeMatchingIgnored) {
    args.push('--ignored=matching');
  }
  const res = await runGitCommand({ cwd: worktreePath, args });
  return parsePorcelainV2Records(worktreePath, res.stdout, options);
}

/**
 * Serializes a non-mutating Git-Index checkpoint for `handle` without advancing `HEAD` or touching `<gitdir>/index`.
 *
 * Captures worktree-local `.git` metadata, `statusMap`, temporary-index `treeSha`, and any spilled oversized untracked blobs.
 *
 * @param {GitWorktreeHandle}                      handle   - Active worktree handle to snapshot.
 * @param {GitCowWorktreeNode['checkpointPolicy']} [policy] - Optional checkpoint policy from `GitCowWorktreeNode`.
 *
 * @returns {Promise<string>} JSON-serialized `GitCheckpointPayload` string.
 */
export async function serializeGitWorktreeCheckpoint(
  handle: GitWorktreeHandle,
  policy?: GitCowWorktreeNode['checkpointPolicy'],
): Promise<string> {
  const headRawContent = await readFile(path.join(handle.gitDirPath, 'HEAD'), 'utf8');
  const idxRes = await runGitCommand({ cwd: handle.worktreePath, args: ['write-tree'] });
  const infoExcludeContent = await readFile(path.join(handle.gitDirPath, 'info', 'exclude'), 'utf8').catch(() => null);
  const meta = await readHarnessMeta(handle.gitDirPath);
  const snapshot = await computeWorktreeStatusMap(handle.worktreePath, {
    excludeGlobs: policy?.excludeGlobs,
    includeMatchingIgnored: true,
  });
  const cleanSnapshot = await computeWorktreeStatusMap(handle.worktreePath, {
    excludeGlobs: policy?.excludeGlobs,
  });
  const maxBytes = policy?.maxUntrackedFileSizeBytes ?? DEFAULT_MAX_UNTRACKED_FILE_SIZE_BYTES;
  const staged = await stageCheckpointTreeAndOversizedBlobs(handle, cleanSnapshot, maxBytes);
  const nodeModulesDigest = await computeNodeModulesDigest(
    handle.worktreePath,
    path.join(handle.gitDirPath, 'harness-ckpt-nm'),
  );
  const payload: GitCheckpointPayload = Object.freeze({
    headSha: staged.headSha,
    headRawContent,
    indexTreeSha: idxRes.stdout.trim(),
    infoExcludeContent,
    meta,
    statusMap: cleanSnapshot.statusMap,
    ignoredPaths: snapshot.ignoredPaths,
    nodeModulesDigest,
    treeSha: staged.treeSha,
    oversizedUntrackedBlobs: staged.oversizedUntrackedBlobs,
  });
  return JSON.stringify(payload);
}

/**
 * Verifies worktree-local `.git` and `node_modules` integrity and diffs post-flight file effects against `fromCheckpointJson`.
 *
 * Immediately invokes `restoreGitWorktreeCheckpoint` and throws a non-leasable error if `.git` or `node_modules` was tampered with.
 *
 * @param {string}                                 fromCheckpointJson - Serialized `GitCheckpointPayload` string.
 * @param {GitWorktreeHandle}                      handle             - Active worktree handle.
 * @param {GitCowWorktreeNode['checkpointPolicy']} [policy]           - Optional checkpoint policy configuration.
 *
 * @returns {Promise<readonly ToolEffect[]>} Synthesized `FsToolEffect` list for the symmetric status difference.
 *
 * @throws {Error} If worktree-local `.git` metadata or `node_modules` was tampered with.
 */
export async function diffGitWorktreeEffects(
  fromCheckpointJson: string,
  handle: GitWorktreeHandle,
  policy?: GitCowWorktreeNode['checkpointPolicy'],
): Promise<readonly ToolEffect[]> {
  const fromCheckpoint = JSON.parse(fromCheckpointJson) as GitCheckpointPayload;
  const integrity = await verifyWorktreeLocalGitIntegrity(handle, fromCheckpoint);
  if (!integrity.intact) {
    await restoreGitWorktreeCheckpoint(handle, fromCheckpointJson, policy);
    throw new Error(`Non-leasable worktree integrity violation in '${handle.worktreePath}': ${integrity.reason ?? 'tampered metadata'}`);
  }
  const initialSnap = await computeWorktreeStatusMap(handle.worktreePath, { excludeGlobs: policy?.excludeGlobs });
  const finalSnap = hasGitignoreChanged(fromCheckpoint.statusMap, initialSnap.statusMap)
    ? await computeWorktreeStatusMap(handle.worktreePath, {
        excludeGlobs: policy?.excludeGlobs,
        includeMatchingIgnored: true,
        baselineIgnoredPaths: new Set(fromCheckpoint.ignoredPaths),
      })
    : initialSnap;
  const symDiff = computeSymmetricStatusDiff(fromCheckpoint.statusMap, finalSnap.statusMap);
  return buildFsDiffToolEffects(handle, symDiff);
}

/**
 * Restores `handle` to `fromCheckpointJson` using the deterministic 4-step Git-Index restoration protocol.
 *
 * Restores `.git` metadata and `.gitignore` rules, unlinks added/colliding paths, checks out `treeSha`, and restores spilled blobs.
 *
 * @param {GitWorktreeHandle}                      handle             - Active worktree handle to restore.
 * @param {string}                                 fromCheckpointJson - Serialized `GitCheckpointPayload` string.
 * @param {GitCowWorktreeNode['checkpointPolicy']} [policy]           - Optional checkpoint policy configuration.
 *
 * @returns {Promise<void>} Resolves once the worktree matches `fromCheckpointJson` bit-for-bit.
 */
export async function restoreGitWorktreeCheckpoint(
  handle: GitWorktreeHandle,
  fromCheckpointJson: string,
  policy?: GitCowWorktreeNode['checkpointPolicy'],
): Promise<void> {
  const fromCheckpoint = JSON.parse(fromCheckpointJson) as GitCheckpointPayload;
  const integrity = await verifyWorktreeLocalGitIntegrity(handle, fromCheckpoint);
  const treePaths = await listTreePaths(handle.worktreePath, fromCheckpoint.treeSha);
  await restoreGitdirMetadataAndGitignores(handle, fromCheckpoint, treePaths);
  const currentSnap = await computeWorktreeStatusMap(handle.worktreePath, {
    excludeGlobs: policy?.excludeGlobs,
    includeMatchingIgnored: true,
    baselineIgnoredPaths: new Set(fromCheckpoint.ignoredPaths),
  });
  const symDiff = computeSymmetricStatusDiff(fromCheckpoint.statusMap, currentSnap.statusMap);
  const preservedPaths = new Set<string>([...treePaths, ...Object.keys(fromCheckpoint.oversizedUntrackedBlobs)]);
  await unlinkAddedAndDirectoryCollisions(handle, symDiff, preservedPaths);
  const pathsToCheckout = !integrity.intact ? 'ALL' : symDiff.filter((p) => treePaths.has(p));
  await checkoutCheckpointTreeAndRestoreIndex(handle, fromCheckpoint, pathsToCheckout);
  await restoreOversizedUntrackedBlobs(handle, fromCheckpoint);
}
