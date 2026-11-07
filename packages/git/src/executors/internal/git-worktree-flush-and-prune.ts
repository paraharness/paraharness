import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  FsGlobMatcherNode,
  GitWorktreeHandle,
  LeaseDelta,
} from '@harness-dsl/core';
import { computePathModeAndSha256 } from './file-digest-and-globs.js';
import { gitCheckpointStatusMap } from './git-checkpoint-status-map.js';
import {
  readHarnessMeta,
  runGitCommand,
  writeHarnessMeta,
} from './git-cli-runner.js';
import {
  CONFLICT_END_REGEX,
  CONFLICT_SEP_REGEX,
  CONFLICT_START_REGEX,
} from './git-executor.constants.js';

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
  let state = 0;
  for (const rawLine of content.split(/\r?\n/)) {
    if (state === 0 && CONFLICT_START_REGEX.test(rawLine)) {
      state = 1;
    } else if (state === 1 && CONFLICT_SEP_REGEX.test(rawLine)) {
      state = 2;
    } else if (state === 2 && CONFLICT_END_REGEX.test(rawLine)) {
      return true;
    }
  }
  return false;
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
export async function gitWorktreePruneResolvedConflicts(
  handle: GitWorktreeHandle,
): Promise<Readonly<Record<string, string>>> {
  const meta = await readHarnessMeta(handle.gitDirPath);
  const mergedConflicts: Record<string, string> = {
    ...meta.unresolvedConflictPaths,
    ...handle.unresolvedConflictPaths,
  };
  const remaining: Record<string, string> = {};
  for (const [relPath, recordedDigest] of Object.entries(mergedConflicts)) {
    const absPath = path.join(handle.worktreePath, relPath);
    const rawDigest = await computePathModeAndSha256(absPath);
    const currentDigest = rawDigest === 'DELETED' ? 'MISSING' : rawDigest;
    const content =
      currentDigest !== 'MISSING'
        ? await readFile(absPath, 'utf8').catch(() => '')
        : '';
    const hasMarkers =
      currentDigest !== 'MISSING' && hasPairedConflictMarkers(content);
    if (currentDigest === recordedDigest || hasMarkers) {
      remaining[relPath] = recordedDigest;
    }
  }
  const frozenRemaining = Object.freeze(remaining);
  await writeHarnessMeta(handle.gitDirPath, {
    ...meta,
    unresolvedConflictPaths: frozenRemaining,
  });
  try {
    Object.assign(handle, { unresolvedConflictPaths: frozenRemaining });
  } catch {
    void 0;
  }
  return frozenRemaining;
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
export async function gitWorktreeFlushCleanParentChanges(
  parentHandle: GitWorktreeHandle,
  excludeGlobs?: readonly string[],
): Promise<string> {
  const remainingConflicts =
    await gitWorktreePruneResolvedConflicts(parentHandle);
  const snapshot = await gitCheckpointStatusMap(parentHandle.worktreePath, {
    excludeGlobs,
  });
  const toAdd: string[] = [];
  const toRemove: string[] = [];
  for (const [relPath, digest] of Object.entries(snapshot.statusMap)) {
    if (remainingConflicts[relPath] !== undefined) continue;
    if (digest === 'DELETED') {
      toRemove.push(relPath);
      continue;
    }
    const content = await readFile(
      path.join(parentHandle.worktreePath, relPath),
      'utf8',
    ).catch(() => '');
    if (!hasPairedConflictMarkers(content)) {
      toAdd.push(relPath);
    }
  }
  const headResult = await runGitCommand({
    cwd: parentHandle.worktreePath,
    args: ['rev-parse', 'HEAD'],
  });
  const headSha = headResult.stdout.trim();
  if (toAdd.length === 0 && toRemove.length === 0) return headSha;
  if (toRemove.length > 0) {
    await runGitCommand({
      cwd: parentHandle.worktreePath,
      args: ['update-index', '--force-remove', '-z', '--stdin'],
      stdin: `${toRemove.join('\0')}\0`,
    });
  }
  if (toAdd.length > 0) {
    await runGitCommand({
      cwd: parentHandle.worktreePath,
      args: ['update-index', '--add', '-z', '--stdin'],
      stdin: `${toAdd.join('\0')}\0`,
    });
  }
  const treeResult = await runGitCommand({
    cwd: parentHandle.worktreePath,
    args: ['write-tree'],
  });
  const treeSha = treeResult.stdout.trim();
  const commitResult = await runGitCommand({
    cwd: parentHandle.worktreePath,
    args: [
      'commit-tree',
      treeSha,
      '-p',
      headSha,
      '-m',
      'harness: flush parent working tree',
    ],
  });
  const commitSha = commitResult.stdout.trim();
  await runGitCommand({
    cwd: parentHandle.worktreePath,
    args: ['update-ref', 'HEAD', commitSha, headSha],
  });
  try {
    Object.assign(parentHandle, { headRef: commitSha });
  } catch {
    void 0;
  }
  return commitSha;
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
export function buildConflictLeaseDelta(
  handle: GitWorktreeHandle,
): LeaseDelta | undefined {
  const globs = Object.keys(handle.unresolvedConflictPaths);
  if (globs.length === 0) return undefined;
  const scopeTag = path.basename(handle.worktreePath);
  const matcher = Object.freeze<FsGlobMatcherNode>({
    type: 'fs:match-globs',
    id: `git-conflict-globs:${scopeTag}`,
    globs: Object.freeze([...globs]),
    mode: 'write',
  });
  return Object.freeze<LeaseDelta>({
    type: 'harness:lease-delta',
    id: `git-conflict-lease:${scopeTag}`,
    grantedMatchers: Object.freeze([matcher]),
  });
}
