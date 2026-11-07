import type {
  GitCowWorktreeNode,
  GitWorktreeHandle,
  ToolEffect,
} from '@harness-dsl/core';
import type { ComputeWorktreeStatusOptions } from './compute-worktree-status-options.js';
import { gitCheckpointDiffEffects } from './git-checkpoint-diff-effects.js';
import { gitCheckpointRestore } from './git-checkpoint-restore.js';
import { gitCheckpointSerialize } from './git-checkpoint-serialize.js';
import { gitCheckpointStatusMap } from './git-checkpoint-status-map.js';
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
export function computeWorktreeStatusMap(
  worktreePath: string,
  options?: ComputeWorktreeStatusOptions,
): Promise<WorktreeStatusSnapshot> {
  return gitCheckpointStatusMap(worktreePath, options);
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
export function serializeGitWorktreeCheckpoint(
  handle: GitWorktreeHandle,
  policy?: GitCowWorktreeNode['checkpointPolicy'],
): Promise<string> {
  return gitCheckpointSerialize(handle, policy);
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
export function diffGitWorktreeEffects(
  fromCheckpointJson: string,
  handle: GitWorktreeHandle,
  policy?: GitCowWorktreeNode['checkpointPolicy'],
): Promise<readonly ToolEffect[]> {
  return gitCheckpointDiffEffects(fromCheckpointJson, handle, policy);
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
export function restoreGitWorktreeCheckpoint(
  handle: GitWorktreeHandle,
  fromCheckpointJson: string,
  policy?: GitCowWorktreeNode['checkpointPolicy'],
): Promise<void> {
  return gitCheckpointRestore(handle, fromCheckpointJson, policy);
}
