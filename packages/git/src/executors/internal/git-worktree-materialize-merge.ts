import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { GitWorktreeHandle } from '@paraharness/core';
import { listTreePaths } from './checkpoint-staging-and-integrity.js';
import { computePathModeAndSha256 } from './file-digest-and-globs.js';
import { gitCheckpointStatusMap } from './git-checkpoint-status-map.js';
import {
  readHarnessMeta,
  runGitCommand,
  updateWorktreeHandleInPlace,
  writeHarnessMeta,
} from './git-cli-runner.js';
import type { MaterializeInFlightMergeParams } from './merge-tree-materializer-params.js';
import type { StatelessMergeTreeResult } from './stateless-merge-tree-result.js';
import type { SynthesizedWorkingTreeCommit } from './synthesized-working-tree-commit.js';

/**
 * Synthesizes a temporary Git tree and commit object over `parentCommitSha` without mutating `<gitdir>/index` or `HEAD`.
 *
 * Stages all dirty tracked and untracked files from `gitCheckpointStatusMap` into a temporary index file.
 *
 * @param {GitWorktreeHandle}             handle          - Worktree handle whose working state should be synthesized.
 * @param {string}                        parentCommitSha - Parent commit SHA (`-p`) for `git commit-tree`.
 * @param {readonly string[] | undefined} [excludeGlobs]  - Optional glob patterns excluded from staging.
 *
 * @returns {Promise<SynthesizedWorkingTreeCommit>} Synthesized tree SHA and commit SHA.
 */
export async function synthesizeWorkingTreeCommitOverBase(
  handle: GitWorktreeHandle,
  parentCommitSha: string,
  excludeGlobs?: readonly string[],
): Promise<SynthesizedWorkingTreeCommit> {
  const headSha = (await runGitCommand({ cwd: handle.worktreePath, args: ['rev-parse', 'HEAD'] })).stdout.trim();
  const snap = await gitCheckpointStatusMap(handle.worktreePath, { excludeGlobs });
  const tmpIndex = path.join(handle.gitDirPath, `harness-synth-idx.${process.pid}.${randomUUID()}`);
  const toAdd: string[] = [];
  const toRemove: string[] = [];
  for (const [relPath, digest] of Object.entries(snap.statusMap)) {
    if (digest === 'DELETED') toRemove.push(relPath);
    else toAdd.push(relPath);
  }
  try {
    await runGitCommand({ cwd: handle.worktreePath, args: ['read-tree', headSha], env: { GIT_INDEX_FILE: tmpIndex } });
    if (toRemove.length > 0) {
      await runGitCommand({ cwd: handle.worktreePath, args: ['update-index', '--force-remove', '-z', '--stdin'], env: { GIT_INDEX_FILE: tmpIndex }, stdin: `${toRemove.join('\0')}\0` });
    }
    if (toAdd.length > 0) {
      await runGitCommand({ cwd: handle.worktreePath, args: ['update-index', '--add', '-z', '--stdin'], env: { GIT_INDEX_FILE: tmpIndex }, stdin: `${toAdd.join('\0')}\0` });
    }
    const treeSha = (await runGitCommand({ cwd: handle.worktreePath, args: ['write-tree'], env: { GIT_INDEX_FILE: tmpIndex } })).stdout.trim();
    const commitSha = (await runGitCommand({ cwd: handle.worktreePath, args: ['commit-tree', treeSha, '-p', parentCommitSha, '-m', 'harness: synthesized worktree state'] })).stdout.trim();
    return Object.freeze<SynthesizedWorkingTreeCommit>({ treeSha, commitSha });
  } finally {
    await rm(tmpIndex, { force: true });
  }
}

/**
 * Executes a stateless 3-way `git merge-tree --write-tree -z` between `targetCommitSha` and `sourceCommitSha` over `baseRef`.
 *
 * Synthesizes `targetPrime` with `baseRef` as its sole immediate parent so Git 2.38+ always uses `baseRef` as the merge base.
 *
 * @param {GitWorktreeHandle} handle          - Worktree handle providing `worktreePath` and `baseRef`.
 * @param {string}            targetCommitSha - Target commit SHA ($C_1$ or $C_{\text{prereq}}$).
 * @param {string}            sourceCommitSha - Source commit SHA ($C_{\text{child}}$ or $C_{\text{root}}$) parented on `handle.baseRef`.
 *
 * @returns {Promise<StatelessMergeTreeResult>} Merge tree result.
 */
export async function executeStatelessMergeTree(
  handle: GitWorktreeHandle,
  targetCommitSha: string,
  sourceCommitSha: string,
): Promise<StatelessMergeTreeResult> {
  const targetTree = (await runGitCommand({ cwd: handle.worktreePath, args: ['rev-parse', `${targetCommitSha}^{tree}`] })).stdout.trim();
  const targetPrime = (await runGitCommand({ cwd: handle.worktreePath, args: ['commit-tree', targetTree, '-p', handle.baseRef, '-m', 'harness: merge-tree target'] })).stdout.trim();
  const mergeOutput = await runGitCommand({
    cwd: handle.worktreePath,
    args: ['merge-tree', '--write-tree', '-z', targetPrime, sourceCommitSha],
    allowNonZeroExit: true,
  });
  const parts = mergeOutput.stdout.split('\0');
  const mergedTreeSha = (parts[0] ?? '').split(/\r?\n/)[0]?.trim() ?? '';
  if (mergeOutput.exitCode === 0) {
    return Object.freeze<StatelessMergeTreeResult>({ clean: true, mergedTreeSha, conflictedPaths: Object.freeze([]) });
  }
  const conflictSet = new Set<string>();
  for (let i = 1; i < parts.length; i += 1) {
    const token = parts[i] ?? '';
    if (token.length === 0) break;
    const tabIdx = token.indexOf('\t');
    if (tabIdx !== -1) conflictSet.add(token.slice(tabIdx + 1));
  }
  return Object.freeze<StatelessMergeTreeResult>({ clean: false, mergedTreeSha, conflictedPaths: Object.freeze([...conflictSet]) });
}

/**
 * Atomically materializes `inFlightMerge` into `handle`'s working tree and updates `HEAD`, `.git/index`, and `baseRef`.
 *
 * Persists `inFlightMerge` in `<gitdir>/harness-meta.json` before modifying files, checks out `mergedTreeSha`, unlinks removed paths, and records conflict digests.
 *
 * @param {GitWorktreeHandle}              handle      - Target worktree handle to materialize into.
 * @param {MaterializeInFlightMergeParams} mergeParams - Merge materialization parameters.
 *
 * @returns {Promise<Readonly<Record<string, string>>>} Frozen map of conflicted paths to their materialized `${mode}:${sha256}` digests.
 */
export async function gitWorktreeMaterializeMerge(
  handle: GitWorktreeHandle,
  mergeParams: MaterializeInFlightMergeParams,
): Promise<Readonly<Record<string, string>>> {
  const meta = await readHarnessMeta(handle.gitDirPath);
  const placeholderConflicts: Record<string, string> = {};
  for (const relPath of mergeParams.conflictedPaths) placeholderConflicts[relPath] = 'PENDING';
  await writeHarnessMeta(handle.gitDirPath, {
    ...meta,
    inFlightMerge: {
      targetHeadSha: mergeParams.targetHeadSha,
      mergedTreeSha: mergeParams.mergedTreeSha,
      priorTreeSha: mergeParams.priorTreeSha,
      unresolvedConflictPaths: placeholderConflicts,
    },
  });
  const basePaths = await listTreePaths(handle.worktreePath, handle.baseRef);
  const priorPaths = await listTreePaths(handle.worktreePath, mergeParams.priorTreeSha);
  const mergedPaths = await listTreePaths(handle.worktreePath, mergeParams.mergedTreeSha);
  const tmpIndex = path.join(handle.gitDirPath, `harness-merge-idx.${process.pid}.${randomUUID()}`);
  try {
    await runGitCommand({ cwd: handle.worktreePath, args: ['read-tree', mergeParams.mergedTreeSha], env: { GIT_INDEX_FILE: tmpIndex } });
    await runGitCommand({ cwd: handle.worktreePath, args: ['checkout-index', '-f', '-a'], env: { GIT_INDEX_FILE: tmpIndex } });
  } finally {
    await rm(tmpIndex, { force: true });
  }
  for (const oldPath of new Set([...basePaths, ...priorPaths])) {
    if (!mergedPaths.has(oldPath)) await rm(path.join(handle.worktreePath, oldPath), { force: true });
  }
  return finalizeMaterializedMergeMetadata(handle, mergeParams);
}

/**
 * Completes `gitWorktreeMaterializeMerge` by updating `HEAD`, live `.git/index`, `baseRef`, and `unresolvedConflictPaths`.
 *
 * Computes post-checkout `${mode}:${sha256}` digests for `conflictedPaths` and clears `inFlightMerge` in `harness-meta.json`.
 *
 * @param {GitWorktreeHandle}              handle      - Target worktree handle.
 * @param {MaterializeInFlightMergeParams} mergeParams - Finalization parameters.
 *
 * @returns {Promise<Readonly<Record<string, string>>>} Frozen map of unresolved conflict paths to materialized digests.
 */
export async function finalizeMaterializedMergeMetadata(
  handle: GitWorktreeHandle,
  mergeParams: MaterializeInFlightMergeParams,
): Promise<Readonly<Record<string, string>>> {
  await runGitCommand({ cwd: handle.worktreePath, args: ['update-ref', '--no-deref', 'HEAD', mergeParams.targetHeadSha] });
  await runGitCommand({ cwd: handle.worktreePath, args: ['read-tree', mergeParams.targetHeadSha] });
  const conflictDigests: Record<string, string> = {};
  for (const relPath of mergeParams.conflictedPaths) {
    const rawDigest = await computePathModeAndSha256(path.join(handle.worktreePath, relPath));
    conflictDigests[relPath] = rawDigest === 'DELETED' ? 'MISSING' : rawDigest;
  }
  const frozenConflicts = Object.freeze(conflictDigests);
  const meta = await readHarnessMeta(handle.gitDirPath);
  const nextBaseBranch = mergeParams.nextBaseBranch ?? meta.baseBranch;
  await writeHarnessMeta(handle.gitDirPath, {
    baseRef: mergeParams.targetHeadSha,
    baseBranch: nextBaseBranch,
    branchName: meta.branchName,
    unresolvedConflictPaths: frozenConflicts,
    pendingParentHeadSha: undefined,
    inFlightMerge: undefined,
    inFlightCommitAndPush: meta.inFlightCommitAndPush,
  });
  updateWorktreeHandleInPlace(handle, {
    baseRef: mergeParams.targetHeadSha,
    baseBranch: nextBaseBranch,
    headRef: mergeParams.targetHeadSha,
    unresolvedConflictPaths: frozenConflicts,
  });
  return frozenConflicts;
}
