import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { GitScopeReceipt, GitWorktreeHandle } from '@harness-dsl/core';
import { listTreePaths } from './checkpoint-staging-and-integrity.js';
import { hasPairedConflictMarkers } from './conflict-pruning-and-parent-flush.js';
import {
  readHarnessMeta,
  runGitCommand,
  writeHarnessMeta,
} from './git-cli-runner.js';
import { computeWorktreeStatusMap } from './porcelain-v2-and-checkpoints.js';

/**
 * Advances `parent` from `c1Sha` to `cTargetSha` using crash-safe `pendingParentHeadSha` and `git read-tree -u -m`.
 *
 * Resets any colliding paths in `parent.unresolvedConflictPaths` or untracked working tree files to match `c1Sha` first.
 *
 * @param {GitWorktreeHandle} parent     - Target parent worktree handle.
 * @param {string}            c1Sha      - Current `parent.HEAD` commit SHA before advancing.
 * @param {string}            cTargetSha - Merged target commit SHA to advance `parent` onto.
 *
 * @returns {Promise<void>} Resolves once `parent` working tree, index, `HEAD`, and `harness-meta.json` are updated.
 */
export async function fastForwardParentToTargetCommit(
  parent: GitWorktreeHandle,
  c1Sha: string,
  cTargetSha: string,
): Promise<void> {
  const meta = await readHarnessMeta(parent.gitDirPath);
  const diffRes = await runGitCommand({
    cwd: parent.worktreePath,
    args: ['diff-tree', '-r', '--name-only', '-z', c1Sha, cTargetSha],
  });
  const touchedPaths = diffRes.stdout.split('\0').filter((p) => p.length > 0);
  const pathsToReset = new Set<string>([...touchedPaths, ...Object.keys(meta.unresolvedConflictPaths)]);
  const c1Paths = await listTreePaths(parent.worktreePath, c1Sha);
  for (const relPath of pathsToReset) {
    if (c1Paths.has(relPath)) {
      await runGitCommand({ cwd: parent.worktreePath, args: ['checkout-index', '-f', '--', relPath], allowNonZeroExit: true });
    } else {
      await rm(path.join(parent.worktreePath, relPath), { force: true });
    }
  }
  await writeHarnessMeta(parent.gitDirPath, { ...meta, pendingParentHeadSha: cTargetSha });
  await runGitCommand({ cwd: parent.worktreePath, args: ['read-tree', '-u', '-m', c1Sha, cTargetSha] });
  await runGitCommand({ cwd: parent.worktreePath, args: ['update-ref', 'HEAD', cTargetSha, c1Sha] });
  const nextConflicts: Record<string, string> = {};
  for (const [relPath, digest] of Object.entries(meta.unresolvedConflictPaths)) {
    if (!pathsToReset.has(relPath)) nextConflicts[relPath] = digest;
  }
  const frozenConflicts = Object.freeze(nextConflicts);
  await writeHarnessMeta(parent.gitDirPath, {
    ...meta,
    pendingParentHeadSha: undefined,
    unresolvedConflictPaths: frozenConflicts,
  });
  try {
    Object.assign(parent, { headRef: cTargetSha, unresolvedConflictPaths: frozenConflicts });
  } catch {
    void 0;
  }
}

/**
 * Pins `refs/harness/candidates/<run-id>/<branch-index>` in the host object store when `handle` is a child fork worktree.
 *
 * Extracts `<run-id>` and `<branch-index>` from `<dir>/forks/<runId>/<forkId>` worktree paths.
 *
 * @param {GitWorktreeHandle} handle  - Worktree handle being inspected.
 * @param {string}            headRef - Synthesized or current commit SHA to pin.
 *
 * @returns {Promise<void>} Resolves once candidate refs are updated.
 */
export async function pinCandidateRefIfSpeculativeBranch(
  handle: GitWorktreeHandle,
  headRef: string,
): Promise<void> {
  const runDir = path.dirname(handle.worktreePath);
  const forksDir = path.dirname(runDir);
  if (path.basename(forksDir) !== 'forks') return;
  const runId = path.basename(runDir);
  const forkName = path.basename(handle.worktreePath);
  const numericMatch = /(\d+)$/.exec(forkName);
  if (numericMatch?.[1] !== undefined) {
    await runGitCommand({
      cwd: handle.worktreePath,
      args: ['update-ref', `refs/harness/candidates/${runId}/${numericMatch[1]}`, headRef],
    });
  }
  await runGitCommand({
    cwd: handle.worktreePath,
    args: ['update-ref', `refs/harness/candidates/${runId}/${forkName}`, headRef],
    allowNonZeroExit: true,
  });
}

/**
 * Scans dirty/untracked files and committed diffs (`baseRef..HEAD`) on `handle` for paired conflict markers.
 *
 * Returns all repository-relative file paths containing `<<<<<<<` / `=======` / `>>>>>>>` marker blocks.
 *
 * @param {GitWorktreeHandle}             handle         - Worktree handle to scan.
 * @param {readonly string[] | undefined} [excludeGlobs] - Optional glob patterns excluded from scanning.
 *
 * @returns {Promise<readonly string[]>} List of file paths containing paired conflict markers.
 */
export async function findWorktreeConflictMarkerPaths(
  handle: GitWorktreeHandle,
  excludeGlobs?: readonly string[],
): Promise<readonly string[]> {
  const snap = await computeWorktreeStatusMap(handle.worktreePath, { excludeGlobs });
  const diffRes = await runGitCommand({
    cwd: handle.worktreePath,
    args: ['diff', '--name-only', '-z', handle.baseRef, 'HEAD'],
    allowNonZeroExit: true,
  });
  const candidatePaths = new Set<string>([
    ...Object.keys(snap.statusMap),
    ...diffRes.stdout.split('\0').filter((p) => p.length > 0),
  ]);
  const markerPaths: string[] = [];
  for (const relPath of candidatePaths) {
    if (snap.statusMap[relPath] === 'DELETED') continue;
    const content = await readFile(path.join(handle.worktreePath, relPath), 'utf8').catch(() => '');
    if (hasPairedConflictMarkers(content)) markerPaths.push(relPath);
  }
  return Object.freeze(markerPaths);
}

/**
 * Resolves the stacked-PR `baseBranch` for `rootHandle` when syncing onto `tipReceipt`.
 *
 * Runs `git fetch origin` (ignoring missing remotes) and checks whether `tipReceipt.branchName` is already merged into `origin/main`.
 *
 * @param {GitWorktreeHandle} rootHandle - Root worktree handle being synced.
 * @param {GitScopeReceipt}   tipReceipt - Terminal scope receipt of the tip prerequisite run.
 *
 * @returns {Promise<string>} Resolved base branch name (`tipReceipt.branchName` when unmerged, or `'main'`).
 */
export async function resolvePrerequisiteBaseBranch(
  rootHandle: GitWorktreeHandle,
  tipReceipt: GitScopeReceipt,
): Promise<string> {
  await runGitCommand({ cwd: rootHandle.worktreePath, args: ['fetch', 'origin'], allowNonZeroExit: true });
  const prereqBranch = tipReceipt.branchName;
  if (prereqBranch === undefined || prereqBranch.length === 0) {
    return rootHandle.baseBranch;
  }
  const isAncestor = await runGitCommand({
    cwd: rootHandle.worktreePath,
    args: ['merge-base', '--is-ancestor', tipReceipt.headRef, 'origin/main'],
    allowNonZeroExit: true,
  });
  return isAncestor.exitCode === 0 ? 'main' : prereqBranch;
}
