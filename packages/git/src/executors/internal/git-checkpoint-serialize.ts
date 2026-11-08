import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { GitCowWorktreeNode, GitWorktreeHandle } from '@paraharness/core';
import type { GitCheckpointPayload } from '../git-checkpoint-payload.js';
import { stageCheckpointTreeAndOversizedBlobs } from './checkpoint-staging-and-integrity.js';
import {
  computeNodeModulesDigest,
  snapshotNodeModulesForCheckpoint,
} from './file-digest-and-globs.js';
import { gitCheckpointStatusMap } from './git-checkpoint-status-map.js';
import { readHarnessMeta, runGitCommand } from './git-cli-runner.js';
import { DEFAULT_MAX_UNTRACKED_FILE_SIZE_BYTES } from './git-executor.constants.js';

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
export async function gitCheckpointSerialize(
  handle: GitWorktreeHandle,
  policy?: GitCowWorktreeNode['checkpointPolicy'],
): Promise<string> {
  const headRawContent = await readFile(
    path.join(handle.gitDirPath, 'HEAD'),
    'utf8',
  );
  const indexTreeResult = await runGitCommand({
    cwd: handle.worktreePath,
    args: ['write-tree'],
  });
  const infoExcludeContent = await readFile(
    path.join(handle.gitDirPath, 'info', 'exclude'),
    'utf8',
  ).catch(() => null);
  const meta = await readHarnessMeta(handle.gitDirPath);
  const snapshot = await gitCheckpointStatusMap(handle.worktreePath, {
    excludeGlobs: policy?.excludeGlobs,
    includeMatchingIgnored: true,
  });
  const maxBytes =
    policy?.maxUntrackedFileSizeBytes ?? DEFAULT_MAX_UNTRACKED_FILE_SIZE_BYTES;
  const staged = await stageCheckpointTreeAndOversizedBlobs(
    handle,
    snapshot,
    maxBytes,
  );
  const nodeModulesDigest = await computeNodeModulesDigest(handle.worktreePath);
  await snapshotNodeModulesForCheckpoint(
    handle.worktreePath,
    nodeModulesDigest,
    path.join(handle.gitDirPath, 'harness-ckpt-nm'),
  );
  const payload: GitCheckpointPayload = Object.freeze({
    headSha: staged.headSha,
    headRawContent,
    indexTreeSha: indexTreeResult.stdout.trim(),
    infoExcludeContent,
    meta,
    statusMap: snapshot.statusMap,
    ignoredPaths: snapshot.ignoredPaths,
    nodeModulesDigest,
    treeSha: staged.treeSha,
    oversizedUntrackedBlobs: staged.oversizedUntrackedBlobs,
  });
  return JSON.stringify(payload);
}
