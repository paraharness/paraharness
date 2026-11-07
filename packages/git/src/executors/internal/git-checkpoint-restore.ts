import type { GitCowWorktreeNode, GitWorktreeHandle } from '@harness-dsl/core';
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
  verifyWorktreeLocalGitIntegrity,
} from './checkpoint-staging-and-integrity.js';
import { gitCheckpointStatusMap } from './git-checkpoint-status-map.js';

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
export async function gitCheckpointRestore(
  handle: GitWorktreeHandle,
  fromCheckpointJson: string,
  policy?: GitCowWorktreeNode['checkpointPolicy'],
): Promise<void> {
  const fromCheckpoint = JSON.parse(fromCheckpointJson) as GitCheckpointPayload;
  const integrity = await verifyWorktreeLocalGitIntegrity(
    handle,
    fromCheckpoint,
  );
  const treePaths = await listTreePaths(
    handle.worktreePath,
    fromCheckpoint.treeSha,
  );
  await restoreGitdirMetadataAndGitignores(handle, fromCheckpoint, treePaths);
  const currentSnap = await gitCheckpointStatusMap(handle.worktreePath, {
    excludeGlobs: policy?.excludeGlobs,
    includeMatchingIgnored: true,
    baselineIgnoredPaths: new Set(fromCheckpoint.ignoredPaths),
  });
  const symDiff = computeSymmetricStatusDiff(
    fromCheckpoint.statusMap,
    currentSnap.statusMap,
  );
  const preservedPaths = new Set<string>([
    ...treePaths,
    ...Object.keys(fromCheckpoint.oversizedUntrackedBlobs),
  ]);
  await unlinkAddedAndDirectoryCollisions(handle, symDiff, preservedPaths);
  const pathsToCheckout = !integrity.intact
    ? 'ALL'
    : symDiff.filter((relPath) => treePaths.has(relPath));
  await checkoutCheckpointTreeAndRestoreIndex(
    handle,
    fromCheckpoint,
    pathsToCheckout,
  );
  await restoreOversizedUntrackedBlobs(handle, fromCheckpoint);
}
