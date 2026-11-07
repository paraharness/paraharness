import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { GitWorktreeHandle } from '@harness-dsl/core';
import { listTreePaths } from './checkpoint-staging-and-integrity.js';
import { computePathModeAndSha256 } from './file-digest-and-globs.js';
import {
  readHarnessMeta,
  runGitCommand,
  writeHarnessMeta,
} from './git-cli-runner.js';
import type { MaterializeInFlightMergeParams } from './merge-tree-materializer-params.js';
import { computeWorktreeStatusMap } from './porcelain-v2-and-checkpoints.js';

/**
 * Synthesizes a temporary Git tree and commit object over `parentCommitSha` without mutating `<gitdir>/index` or `HEAD`.
 *
 * Stages all dirty tracked and untracked files from `computeWorktreeStatusMap` into a temporary index file.
 *
 * @param {GitWorktreeHandle}             handle          - Worktree handle whose working state should be synthesized.
 * @param {string}                        parentCommitSha - Parent commit SHA (`-p`) for `git commit-tree`.
 * @param {readonly string[] | undefined} [excludeGlobs]  - Optional glob patterns excluded from staging.
 *
 * @returns {Promise<Readonly<Record<'treeSha' | 'commitSha', string>>>} Synthesized tree SHA and commit SHA.
 */
export async function synthesizeWorkingTreeCommitOverBase(
  handle: GitWorktreeHandle,
  parentCommitSha: string,
  excludeGlobs?: readonly string[],
): Promise<Readonly<Record<'treeSha' | 'commitSha', string>>> {
  const headSha = (await runGitCommand({ cwd: handle.worktreePath, args: ['rev-parse', 'HEAD'] })).stdout.trim();
  const snap = await computeWorktreeStatusMap(handle.worktreePath, { excludeGlobs });
  const tmpIndex = path.join(handle.gitDirPath, `harness-synth-idx.${process.pid}.${Date.now()}`);
  const toAdd: string[] = [];
  const toRemove: string[] = [];
  for (const [relPath, digest] of Object.entries(snap.statusMap)) {
    if (digest === 'DELETED') toRemove.push(relPath);
    else toAdd.push(relPath);
  }
  try {
    await runGitCommand({ cwd: handle.worktreePath, args: ['read-tree', headSha], env: { GIT_INDEX_FILE: tmpIndex } });
    if (toAdd.length > 0) await runGitCommand({ cwd: handle.worktreePath, args: ['update-index', '--add', '-z', '--stdin'], env: { GIT_INDEX_FILE: tmpIndex }, stdin: `${toAdd.join('\0')}\0` });
    if (toRemove.length > 0) await runGitCommand({ cwd: handle.worktreePath, args: ['update-index', '--force-remove', '-z', '--stdin'], env: { GIT_INDEX_FILE: tmpIndex }, stdin: `${toRemove.join('\0')}\0` });
    const treeSha = (await runGitCommand({ cwd: handle.worktreePath, args: ['write-tree'], env: { GIT_INDEX_FILE: tmpIndex } })).stdout.trim();
    const commitSha = (await runGitCommand({ cwd: handle.worktreePath, args: ['commit-tree', treeSha, '-p', parentCommitSha, '-m', 'harness: synthesized worktree state'] })).stdout.trim();
    return Object.freeze({ treeSha, commitSha });
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
 * @returns {Promise<Readonly<Record<'mergedTreeSha', string>> & Readonly<Record<'clean', boolean>> & Readonly<Record<'conflictedPaths', readonly string[]>>>} Merge tree result.
 */
export async function executeStatelessMergeTree(
  handle: GitWorktreeHandle,
  targetCommitSha: string,
  sourceCommitSha: string,
): Promise<
  Readonly<Record<'mergedTreeSha', string>> &
    Readonly<Record<'clean', boolean>> &
    Readonly<Record<'conflictedPaths', readonly string[]>>
> {
  const targetTree = (await runGitCommand({ cwd: handle.worktreePath, args: ['rev-parse', `${targetCommitSha}^{tree}`] })).stdout.trim();
  const targetPrime = (await runGitCommand({ cwd: handle.worktreePath, args: ['commit-tree', targetTree, '-p', handle.baseRef, '-m', 'harness: merge-tree target'] })).stdout.trim();
  const mergeRes = await runGitCommand({
    cwd: handle.worktreePath,
    args: ['merge-tree', '--write-tree', '-z', targetPrime, sourceCommitSha],
    allowNonZeroExit: true,
  });
  const parts = mergeRes.stdout.split('\0');
  const mergedTreeSha = (parts[0] ?? '').split(/\r?\n/)[0]?.trim() ?? '';
  if (mergeRes.exitCode === 0) {
    return Object.freeze({ clean: true, mergedTreeSha, conflictedPaths: Object.freeze([]) });
  }
  const conflictSet = new Set<string>();
  for (let i = 1; i < parts.length; i += 1) {
    const token = parts[i] ?? '';
    if (token.length === 0) break;
    const tabIdx = token.indexOf('\t');
    if (tabIdx !== -1) conflictSet.add(token.slice(tabIdx + 1));
  }
  return Object.freeze({ clean: false, mergedTreeSha, conflictedPaths: Object.freeze([...conflictSet]) });
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
export async function materializeInFlightMergeIntoWorktree(
  handle: GitWorktreeHandle,
  mergeParams: MaterializeInFlightMergeParams,
): Promise<Readonly<Record<string, string>>> {
  const meta = await readHarnessMeta(handle.gitDirPath);
  const placeholderConflicts: Record<string, string> = {};
  for (const p of mergeParams.conflictedPaths) placeholderConflicts[p] = 'PENDING';
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
  const tmpIndex = path.join(handle.gitDirPath, `harness-merge-idx.${process.pid}.${Date.now()}`);
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
 * Completes `materializeInFlightMergeIntoWorktree` by updating `HEAD`, live `.git/index`, `baseRef`, and `unresolvedConflictPaths`.
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
  try {
    Object.assign(handle, {
      baseRef: mergeParams.targetHeadSha,
      baseBranch: nextBaseBranch,
      headRef: mergeParams.targetHeadSha,
      unresolvedConflictPaths: frozenConflicts,
    });
  } catch {
    void 0;
  }
  return frozenConflicts;
}
