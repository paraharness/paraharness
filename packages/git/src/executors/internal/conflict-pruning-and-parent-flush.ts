import type {
  GitWorktreeHandle,
  LeaseDelta,
} from '@harness-dsl/core';
import {
  buildConflictLeaseDelta as buildConflictLease,
  gitWorktreeFlushCleanParentChanges,
  gitWorktreePruneResolvedConflicts,
  hasPairedConflictMarkers as checkPairedConflictMarkers,
} from './git-worktree-flush-and-prune.js';

/**
 * Tests whether `content` contains a complete paired Git conflict marker block (`<<<<<<< `, `=======`, `>>>>>>> `).
 *
 * Ignores standalone Markdown `=======` headings that are not preceded by `^<{7} ` and followed by `^>{7} `.
 *
 * @param {string} content - UTF-8 file or diff text to inspect.
 *
 * @returns {boolean} `true` if a complete paired conflict marker block is present.
 */
export function hasPairedConflictMarkers(content: string): boolean {
  return checkPairedConflictMarkers(content);
}

/**
 * Prunes entries in `handle.unresolvedConflictPaths` whose working-tree digest changed and contain no conflict markers.
 *
 * Persists the updated `unresolvedConflictPaths` map in `<gitdir>/harness-meta.json` and updates `handle` in-place.
 *
 * @param {GitWorktreeHandle} handle - Worktree handle whose conflict map should be pruned.
 *
 * @returns {Promise<Readonly<Record<string, string>>>} Frozen map of remaining unresolved conflict paths to digests.
 */
export function pruneResolvedConflictPaths(
  handle: GitWorktreeHandle,
): Promise<Readonly<Record<string, string>>> {
  return gitWorktreePruneResolvedConflicts(handle);
}

/**
 * Auto-commits non-conflicted dirty working-tree files on `parentHandle` onto `parentHandle.HEAD`.
 *
 * Keeps `parentHandle.baseRef` pinned while advancing `parentHandle.HEAD` so child forks and 3-way merges see parent edits.
 *
 * @param {GitWorktreeHandle}             parentHandle   - Parent worktree handle to flush.
 * @param {readonly string[] | undefined} [excludeGlobs] - Optional glob patterns excluded from status scanning.
 *
 * @returns {Promise<string>} Resolved `HEAD` commit SHA on `parentHandle` after flushing.
 */
export function flushParentWorkingTreeCleanChanges(
  parentHandle: GitWorktreeHandle,
  excludeGlobs?: readonly string[],
): Promise<string> {
  return gitWorktreeFlushCleanParentChanges(parentHandle, excludeGlobs);
}

/**
 * Constructs the temporary `LeaseDelta` (`type: 'harness:lease-delta'`) granting write access to `handle.unresolvedConflictPaths`.
 *
 * Returns `undefined` when `handle.unresolvedConflictPaths` is empty, without importing `@harness-dsl/fs`.
 *
 * @param {GitWorktreeHandle} handle - Worktree handle to inspect for unresolved conflicts.
 *
 * @returns {LeaseDelta | undefined} Frozen `LeaseDelta` unlocking conflicted paths, or `undefined`.
 */
export function buildConflictLeaseDelta(handle: GitWorktreeHandle): LeaseDelta | undefined {
  return buildConflictLease(handle);
}
