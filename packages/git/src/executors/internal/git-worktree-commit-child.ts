import type {
  GitScopeReceipt,
  GitWorktreeHandle,
  ReconcileResult,
} from '@metaharness/core';
import { GitScopeReceiptSchema } from '../../schemas/git-receipts.schema.js';
import { gitCheckpointStatusMap } from './git-checkpoint-status-map.js';
import { runGitCommand } from './git-cli-runner.js';
import {
  gitWorktreeFlushCleanParentChanges,
  gitWorktreePruneResolvedConflicts,
} from './git-worktree-flush-and-prune.js';
import {
  executeStatelessMergeTree,
  gitWorktreeMaterializeMerge,
  synthesizeWorkingTreeCommitOverBase,
} from './git-worktree-materialize-merge.js';
import {
  fastForwardParentToTargetCommit,
  findWorktreeConflictMarkerPaths,
  pinCandidateRefIfSpeculativeBranch,
} from './parent-fast-forward.js';

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
export async function gitWorktreeInspectNonMutating(
  handle: GitWorktreeHandle,
  excludeGlobs?: readonly string[],
): Promise<GitScopeReceipt> {
  const snap = await gitCheckpointStatusMap(handle.worktreePath, { excludeGlobs });
  const currentHead = (await runGitCommand({ cwd: handle.worktreePath, args: ['rev-parse', 'HEAD'] })).stdout.trim();
  let headRef: string;
  if (Object.keys(snap.statusMap).length === 0 && currentHead !== handle.baseRef) {
    const ancestorCheck = await runGitCommand({
      cwd: handle.worktreePath,
      args: ['merge-base', '--is-ancestor', handle.baseRef, currentHead],
      allowNonZeroExit: true,
    });
    headRef = ancestorCheck.exitCode === 0
      ? currentHead
      : (await synthesizeWorkingTreeCommitOverBase(handle, handle.baseRef, excludeGlobs)).commitSha;
  } else {
    headRef = (await synthesizeWorkingTreeCommitOverBase(handle, handle.baseRef, excludeGlobs)).commitSha;
  }
  await pinCandidateRefIfSpeculativeBranch(handle, headRef);
  const statOutput = await runGitCommand({ cwd: handle.worktreePath, args: ['diff', '--stat', handle.baseRef, headRef] });
  const filesOutput = await runGitCommand({ cwd: handle.worktreePath, args: ['diff', '--name-only', '-z', handle.baseRef, headRef] });
  const mutatedFiles = filesOutput.stdout.split('\0').filter((relPath) => relPath.length > 0);
  return GitScopeReceiptSchema.parse({
    headRef,
    baseRef: handle.baseRef,
    branchName: handle.branchName,
    baseBranch: handle.baseBranch,
    diffStat: statOutput.stdout.trim(),
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
export async function gitWorktreeCommitChild(
  child: GitWorktreeHandle,
  parent: GitWorktreeHandle,
  excludeGlobs?: readonly string[],
): Promise<ReconcileResult<GitScopeReceipt>> {
  const remainingConflicts = await gitWorktreePruneResolvedConflicts(child);
  const markerPaths = await findWorktreeConflictMarkerPaths(child, excludeGlobs);
  if (Object.keys(remainingConflicts).length > 0 || markerPaths.length > 0) {
    const unresolved = [...new Set([...Object.keys(remainingConflicts), ...markerPaths])];
    const receipt = await gitWorktreeInspectNonMutating(child, excludeGlobs);
    return { status: 'conflict', conflictedSummary: `Unresolved conflicts on child worktree: ${unresolved.join(', ')}`, data: receipt };
  }
  const c1Sha = await gitWorktreeFlushCleanParentChanges(parent, excludeGlobs);
  const childSynth = await synthesizeWorkingTreeCommitOverBase(child, child.baseRef, excludeGlobs);
  if (child.baseRef === c1Sha) {
    await fastForwardParentToTargetCommit(parent, c1Sha, childSynth.commitSha);
    return { status: 'clean', data: await gitWorktreeInspectNonMutating(parent, excludeGlobs) };
  }
  const mergeOutcome = await executeStatelessMergeTree(child, c1Sha, childSynth.commitSha);
  if (mergeOutcome.clean) {
    const commitOutput = await runGitCommand({ cwd: parent.worktreePath, args: ['commit-tree', mergeOutcome.mergedTreeSha, '-p', c1Sha, '-m', 'harness: commit child merge'] });
    await fastForwardParentToTargetCommit(parent, c1Sha, commitOutput.stdout.trim());
    return { status: 'clean', data: await gitWorktreeInspectNonMutating(parent, excludeGlobs) };
  }
  await gitWorktreeMaterializeMerge(child, {
    targetHeadSha: c1Sha,
    mergedTreeSha: mergeOutcome.mergedTreeSha,
    priorTreeSha: childSynth.treeSha,
    conflictedPaths: mergeOutcome.conflictedPaths,
  });
  const receipt = await gitWorktreeInspectNonMutating(child, excludeGlobs);
  return { status: 'conflict', conflictedSummary: `3-way merge conflict on paths: ${mergeOutcome.conflictedPaths.join(', ')}`, data: receipt };
}
