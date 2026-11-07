import type {
  GitMergeQueueNode,
  GitWorktreeHandle,
  StepExecutionContext,
} from '@harness-dsl/core';
import { runGitCommand } from './git-cli-runner.js';
import {
  bisectFailingRebaseChain,
  buildCumulativeRebaseChain,
  evaluateWorktreeCheck,
} from './merge-train-bisector.js';
import type { MergeTrainCandidate } from './merge-train-candidate.js';
import type { MergeTrainResult } from './merge-train-result.js';

/**
 * Runs the iterative cumulative rebase train and binary bisection loop for `git.mergeQueue`.
 *
 * Lands valid candidate prefixes onto `node.targetBranch` and evicts offending candidate branches.
 *
 * @param {GitMergeQueueNode<unknown, unknown>}     node       - Merge queue step AST node.
 * @param {readonly MergeTrainCandidate[]}          candidates - Normalized candidate branches for the batch.
 * @param {StepExecutionContext<GitWorktreeHandle>} ctx        - Active step execution context.
 *
 * @returns {Promise<MergeTrainResult>} Completed batch merge-train outcome.
 */
export async function executeBatchMergeTrainQueue(
  node: GitMergeQueueNode<unknown, unknown>,
  candidates: readonly MergeTrainCandidate[],
  ctx: StepExecutionContext<GitWorktreeHandle>,
): Promise<MergeTrainResult> {
  const cwd = ctx.scopeHandle.worktreePath;
  await runGitCommand({ cwd, args: ['fetch', 'origin'], allowNonZeroExit: true });
  const targetLookup = await runGitCommand({
    cwd,
    args: ['rev-parse', '--verify', `refs/remotes/origin/${node.targetBranch}`],
    allowNonZeroExit: true,
  });
  let currentTargetSha = targetLookup.exitCode === 0
    ? targetLookup.stdout.trim()
    : (await runGitCommand({ cwd, args: ['rev-parse', node.targetBranch], allowNonZeroExit: true })).stdout.trim() || ctx.scopeHandle.baseRef;
  const landedBranches: string[] = [];
  const evictedBranches: string[] = [];
  let verificationRuns = 0;
  let queue = [...candidates];
  while (queue.length > 0) {
    const [chain, conflictedIdx] = await buildCumulativeRebaseChain(cwd, currentTargetSha, queue);
    const tipEntry = chain[chain.length - 1];
    if (tipEntry === undefined) {
      if (queue[0] !== undefined) evictedBranches.push(queue[0].label);
      queue = queue.slice(1);
      continue;
    }
    await runGitCommand({ cwd, args: ['reset', '--hard', tipEntry.rebasedSha] });
    verificationRuns += 1;
    const tipCheck = await evaluateWorktreeCheck(node.verifyWith, ctx);
    if (tipCheck.ok) {
      currentTargetSha = tipEntry.rebasedSha;
      for (const entry of chain) landedBranches.push(entry.candidate.label);
      const conflictedItem = conflictedIdx >= 0 ? queue[conflictedIdx] : undefined;
      if (conflictedItem !== undefined) evictedBranches.push(conflictedItem.label);
      queue = conflictedIdx >= 0 ? queue.slice(conflictedIdx + 1) : [];
    } else {
      const [badIdx, bisectRuns] = await bisectFailingRebaseChain(chain, node.verifyWith, ctx);
      verificationRuns += bisectRuns;
      const priorEntry = badIdx > 0 ? chain[badIdx - 1] : undefined;
      if (priorEntry !== undefined) currentTargetSha = priorEntry.rebasedSha;
      for (let j = 0; j < badIdx; j += 1) {
        const prefixEntry = chain[j];
        if (prefixEntry !== undefined) landedBranches.push(prefixEntry.candidate.label);
      }
      const badEntry = chain[badIdx];
      if (badEntry !== undefined) evictedBranches.push(badEntry.candidate.label);
      queue = queue.slice(badIdx + 1);
    }
  }
  await runGitCommand({ cwd, args: ['reset', '--hard', currentTargetSha] });
  await runGitCommand({ cwd, args: ['update-ref', `refs/heads/${node.targetBranch}`, currentTargetSha], allowNonZeroExit: true });
  await runGitCommand({ cwd, args: ['push', 'origin', `${currentTargetSha}:refs/heads/${node.targetBranch}`], allowNonZeroExit: true });
  return { targetBranch: node.targetBranch, headRef: currentTargetSha, landedBranches, evictedBranches, verificationRuns };
}
