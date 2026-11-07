import type {
  GitScopeReceipt,
  GitSyncReceipt,
  GitWorktreeHandle,
  ReconcileResult,
} from '@harness-dsl/core';
import {
  GitScopeReceiptSchema,
  GitSyncReceiptSchema,
} from '../../schemas/git-receipts.schema.js';
import {
  flushParentWorkingTreeCleanChanges,
  pruneResolvedConflictPaths,
} from './conflict-pruning-and-parent-flush.js';
import { runGitCommand } from './git-cli-runner.js';
import {
  executeStatelessMergeTree,
  materializeInFlightMergeIntoWorktree,
  synthesizeWorkingTreeCommitOverBase,
} from './merge-tree-materializer.js';
import {
  fastForwardParentToTargetCommit,
  findWorktreeConflictMarkerPaths,
  pinCandidateRefIfSpeculativeBranch,
  resolvePrerequisiteBaseBranch,
} from './parent-fast-forward.js';
import { computeWorktreeStatusMap } from './porcelain-v2-and-checkpoints.js';

/**
 * Captures a 100% non-mutating `GitScopeReceipt` for `handle` using a temporary index file.
 *
 * Reuses `HEAD` directly when the working tree is clean and `HEAD` descends from `baseRef`,
 * and pins `refs/harness/candidates/<run-id>/<branch-index>` for child fork worktrees.
 *
 * @param {GitWorktreeHandle}             handle         - Active worktree handle to inspect.
 * @param {readonly string[] | undefined} [excludeGlobs] - Optional glob patterns excluded from staging.
 *
 * @returns {Promise<GitScopeReceipt>} Validated `GitScopeReceipt` with `headRef`, `diffStat`, and `mutatedFiles`.
 */
export async function inspectGitWorktreeNonMutating(
  handle: GitWorktreeHandle,
  excludeGlobs?: readonly string[],
): Promise<GitScopeReceipt> {
  const snap = await computeWorktreeStatusMap(handle.worktreePath, { excludeGlobs });
  const currentHead = (await runGitCommand({ cwd: handle.worktreePath, args: ['rev-parse', 'HEAD'] })).stdout.trim();
  let headRef: string;
  if (Object.keys(snap.statusMap).length === 0 && currentHead !== handle.baseRef) {
    const anc = await runGitCommand({
      cwd: handle.worktreePath,
      args: ['merge-base', '--is-ancestor', handle.baseRef, currentHead],
      allowNonZeroExit: true,
    });
    headRef = anc.exitCode === 0 ? currentHead : (await synthesizeWorkingTreeCommitOverBase(handle, handle.baseRef, excludeGlobs)).commitSha;
  } else {
    headRef = (await synthesizeWorkingTreeCommitOverBase(handle, handle.baseRef, excludeGlobs)).commitSha;
  }
  await pinCandidateRefIfSpeculativeBranch(handle, headRef);
  const statRes = await runGitCommand({ cwd: handle.worktreePath, args: ['diff', '--stat', handle.baseRef, headRef] });
  const filesRes = await runGitCommand({ cwd: handle.worktreePath, args: ['diff', '--name-only', '-z', handle.baseRef, headRef] });
  const mutatedFiles = filesRes.stdout.split('\0').filter((p) => p.length > 0);
  return GitScopeReceiptSchema.parse({
    headRef,
    baseRef: handle.baseRef,
    branchName: handle.branchName,
    baseBranch: handle.baseBranch,
    diffStat: statRes.stdout.trim(),
    mutatedFiles,
  });
}

/**
 * Reconciles `child` into `parent` via stateless 3-way `git merge-tree --write-tree` without polluting `parent` on conflict.
 *
 * Leaves `child.baseRef` untouched on a clean merge, or materializes conflicts into `child` and advances `child.baseRef = C_1` on conflict.
 *
 * @param {GitWorktreeHandle}             child          - Completed child worktree handle.
 * @param {GitWorktreeHandle}             parent         - Target parent worktree handle.
 * @param {readonly string[] | undefined} [excludeGlobs] - Optional glob patterns excluded from staging.
 *
 * @returns {Promise<ReconcileResult<GitScopeReceipt>>} Clean or conflicted reconciliation result.
 */
export async function commitChildViaMergeTree(
  child: GitWorktreeHandle,
  parent: GitWorktreeHandle,
  excludeGlobs?: readonly string[],
): Promise<ReconcileResult<GitScopeReceipt>> {
  const remainingConflicts = await pruneResolvedConflictPaths(child);
  const markerPaths = await findWorktreeConflictMarkerPaths(child, excludeGlobs);
  if (Object.keys(remainingConflicts).length > 0 || markerPaths.length > 0) {
    const unresolved = [...new Set([...Object.keys(remainingConflicts), ...markerPaths])];
    const data = await inspectGitWorktreeNonMutating(child, excludeGlobs);
    return { status: 'conflict', conflictedSummary: `Unresolved conflicts on child worktree: ${unresolved.join(', ')}`, data };
  }
  const c1Sha = await flushParentWorkingTreeCleanChanges(parent, excludeGlobs);
  const childSynth = await synthesizeWorkingTreeCommitOverBase(child, child.baseRef, excludeGlobs);
  if (child.baseRef === c1Sha) {
    await fastForwardParentToTargetCommit(parent, c1Sha, childSynth.commitSha);
    return { status: 'clean', data: await inspectGitWorktreeNonMutating(parent, excludeGlobs) };
  }
  const mergeRes = await executeStatelessMergeTree(child, c1Sha, childSynth.commitSha);
  if (mergeRes.clean) {
    const commitRes = await runGitCommand({ cwd: parent.worktreePath, args: ['commit-tree', mergeRes.mergedTreeSha, '-p', c1Sha, '-m', 'harness: commit child merge'] });
    await fastForwardParentToTargetCommit(parent, c1Sha, commitRes.stdout.trim());
    return { status: 'clean', data: await inspectGitWorktreeNonMutating(parent, excludeGlobs) };
  }
  await materializeInFlightMergeIntoWorktree(child, {
    targetHeadSha: c1Sha,
    mergedTreeSha: mergeRes.mergedTreeSha,
    priorTreeSha: childSynth.treeSha,
    conflictedPaths: mergeRes.conflictedPaths,
  });
  const data = await inspectGitWorktreeNonMutating(child, excludeGlobs);
  return { status: 'conflict', conflictedSummary: `3-way merge conflict on paths: ${mergeRes.conflictedPaths.join(', ')}`, data };
}

/**
 * Rebases/merges uncommitted changes in `pausedChild` onto an updated `parent` worktree via `git merge-tree --write-tree`.
 *
 * Preserves dirty edits in `pausedChild` and records any conflicted paths in `pausedChild.unresolvedConflictPaths`.
 *
 * @param {GitWorktreeHandle}             parent         - Updated parent worktree handle.
 * @param {GitWorktreeHandle}             pausedChild    - Suspended child worktree handle being synced.
 * @param {readonly string[] | undefined} [excludeGlobs] - Optional glob patterns excluded from staging.
 *
 * @returns {Promise<ReconcileResult<GitSyncReceipt>>} Clean or conflicted synchronization receipt.
 */
export async function syncChildViaMergeTree(
  parent: GitWorktreeHandle,
  pausedChild: GitWorktreeHandle,
  excludeGlobs?: readonly string[],
): Promise<ReconcileResult<GitSyncReceipt>> {
  const c0Sha = pausedChild.baseRef;
  const c1Sha = await flushParentWorkingTreeCleanChanges(parent, excludeGlobs);
  const childSynth = await synthesizeWorkingTreeCommitOverBase(pausedChild, c0Sha, excludeGlobs);
  const mergeRes = await executeStatelessMergeTree(pausedChild, c1Sha, childSynth.commitSha);
  await materializeInFlightMergeIntoWorktree(pausedChild, {
    targetHeadSha: c1Sha,
    mergedTreeSha: mergeRes.mergedTreeSha,
    priorTreeSha: childSynth.treeSha,
    conflictedPaths: mergeRes.conflictedPaths,
    nextBaseBranch: parent.baseBranch,
  });
  const diffRes = await runGitCommand({ cwd: pausedChild.worktreePath, args: ['diff-tree', '-r', '--name-only', '-z', c0Sha, c1Sha] });
  const updatedFiles = diffRes.stdout.split('\0').filter((p) => p.length > 0);
  const receipt = GitSyncReceiptSchema.parse({ rebasedOntoRef: c1Sha, baseBranch: parent.baseBranch, updatedFiles });
  if (mergeRes.clean) return { status: 'clean', data: receipt };
  return {
    status: 'conflict',
    conflictedSummary: `syncChild conflict on paths: ${mergeRes.conflictedPaths.join(', ')}`,
    data: receipt,
  };
}

/**
 * Synchronizes `rootHandle` onto the tip prerequisite receipt in `prerequisiteReceipts` via `git merge-tree --write-tree`.
 *
 * Auto-flushes clean dirty edits on `rootHandle`, resolves stacked `baseBranch`, and materializes the 3-way merge.
 *
 * @param {GitWorktreeHandle}             rootHandle           - Task root worktree handle.
 * @param {readonly GitScopeReceipt[]}    prerequisiteReceipts - Terminal scope receipts of completed prerequisites.
 * @param {readonly string[] | undefined} [excludeGlobs]       - Optional glob patterns excluded from staging.
 *
 * @returns {Promise<ReconcileResult<GitSyncReceipt>>} Clean or conflicted synchronization receipt.
 */
export async function syncRootViaMergeTree(
  rootHandle: GitWorktreeHandle,
  prerequisiteReceipts: readonly GitScopeReceipt[],
  excludeGlobs?: readonly string[],
): Promise<ReconcileResult<GitSyncReceipt>> {
  const tipReceipt = prerequisiteReceipts[prerequisiteReceipts.length - 1];
  if (tipReceipt === undefined) {
    return {
      status: 'clean',
      data: GitSyncReceiptSchema.parse({ rebasedOntoRef: rootHandle.baseRef, baseBranch: rootHandle.baseBranch, updatedFiles: [] }),
    };
  }
  const c0Sha = rootHandle.baseRef;
  await flushParentWorkingTreeCleanChanges(rootHandle, excludeGlobs);
  const resolvedBaseBranch = await resolvePrerequisiteBaseBranch(rootHandle, tipReceipt);
  const rootSynth = await synthesizeWorkingTreeCommitOverBase(rootHandle, c0Sha, excludeGlobs);
  const mergeRes = await executeStatelessMergeTree(rootHandle, tipReceipt.headRef, rootSynth.commitSha);
  await materializeInFlightMergeIntoWorktree(rootHandle, {
    targetHeadSha: tipReceipt.headRef,
    mergedTreeSha: mergeRes.mergedTreeSha,
    priorTreeSha: rootSynth.treeSha,
    conflictedPaths: mergeRes.conflictedPaths,
    nextBaseBranch: resolvedBaseBranch,
  });
  const diffRes = await runGitCommand({ cwd: rootHandle.worktreePath, args: ['diff-tree', '-r', '--name-only', '-z', c0Sha, tipReceipt.headRef] });
  const updatedFiles = diffRes.stdout.split('\0').filter((p) => p.length > 0);
  const receipt = GitSyncReceiptSchema.parse({ rebasedOntoRef: tipReceipt.headRef, baseBranch: resolvedBaseBranch, updatedFiles });
  if (mergeRes.clean) return { status: 'clean', data: receipt };
  return {
    status: 'conflict',
    conflictedSummary: `syncRoot conflict on paths: ${mergeRes.conflictedPaths.join(', ')}`,
    data: receipt,
  };
}
