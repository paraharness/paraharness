import type {
  GitCowWorktreeNode,
  GitWorktreeHandle,
  ToolEffect,
} from '@paraharness/core';
import type { GitCheckpointPayload } from '../git-checkpoint-payload.js';
import {
  computeSymmetricStatusDiff,
  verifyWorktreeLocalGitIntegrity,
} from './checkpoint-staging-and-integrity.js';
import { gitCheckpointRestore } from './git-checkpoint-restore.js';
import { gitCheckpointStatusMap } from './git-checkpoint-status-map.js';
import {
  buildFsDiffToolEffects,
  hasGitignoreChanged,
} from './porcelain-v2-parser.js';

/**
 * Verifies worktree-local `.git` and `node_modules` integrity and diffs post-flight file effects against `fromCheckpointJson`.
 *
 * Immediately invokes `gitCheckpointRestore` and throws a non-leasable error if `.git` or `node_modules` was tampered with.
 *
 * @param {string}                                 fromCheckpointJson - Serialized `GitCheckpointPayload` string.
 * @param {GitWorktreeHandle}                      handle             - Active worktree handle.
 * @param {GitCowWorktreeNode['checkpointPolicy']} [policy]           - Optional checkpoint policy configuration.
 *
 * @returns {Promise<readonly ToolEffect[]>} Synthesized `FsToolEffect` list for the symmetric status difference.
 *
 * @throws {Error} If worktree-local `.git` metadata or `node_modules` was tampered with.
 */
export async function gitCheckpointDiffEffects(
  fromCheckpointJson: string,
  handle: GitWorktreeHandle,
  policy?: GitCowWorktreeNode['checkpointPolicy'],
): Promise<readonly ToolEffect[]> {
  const fromCheckpoint = JSON.parse(fromCheckpointJson) as GitCheckpointPayload;
  const integrity = await verifyWorktreeLocalGitIntegrity(
    handle,
    fromCheckpoint,
  );
  if (!integrity.intact) {
    await gitCheckpointRestore(handle, fromCheckpointJson, policy);
    throw new Error(
      `Non-leasable worktree integrity violation in '${handle.worktreePath}': ${integrity.reason ?? 'tampered metadata'}`,
    );
  }
  const initialSnap = await gitCheckpointStatusMap(handle.worktreePath, {
    excludeGlobs: policy?.excludeGlobs,
  });
  const finalSnap = hasGitignoreChanged(
    fromCheckpoint.statusMap,
    initialSnap.statusMap,
  )
    ? await gitCheckpointStatusMap(handle.worktreePath, {
        excludeGlobs: policy?.excludeGlobs,
        includeMatchingIgnored: true,
        baselineIgnoredPaths: new Set(fromCheckpoint.ignoredPaths),
      })
    : initialSnap;
  const symDiff = computeSymmetricStatusDiff(
    fromCheckpoint.statusMap,
    finalSnap.statusMap,
  );
  return buildFsDiffToolEffects(handle, symDiff);
}
