import type {
  GitMergeQueueNode,
  GitWorktreeHandle,
  StepExecutionContext,
} from '@harness-dsl/core';
import { runGitCommand } from './git-cli-runner.js';
import {
  buildCumulativeRebaseChain,
  evaluateWorktreeCheck,
  gitMergeTrainBisect,
} from './git-merge-train-bisect.js';
import type { MergeTrainCandidate } from './merge-train-candidate.js';
import type { MergeTrainChainEntry } from './merge-train-chain-entry.js';
import type { MergeTrainResult } from './merge-train-result.js';

/**
 * Parameters for verifying or binary-bisecting a single cumulative rebase chain iteration in `git.mergeQueue`.
 */
interface VerifyOrBisectMergeTrainChainParams {
  /** Merge queue step AST node. */
  readonly node: GitMergeQueueNode<unknown, unknown>;
  /** Active step execution context. */
  readonly ctx: StepExecutionContext<GitWorktreeHandle>;
  /** Cumulative speculative rebase chain entries. */
  chain: readonly MergeTrainChainEntry[];
  /** Index of the first candidate that failed to rebase cleanly, or `-1` if all rebased cleanly. */
  conflictedIdx: number;
  /** Mutable list of candidate labels landed across iterations. */
  readonly landedBranches: string[];
  /** Mutable list of candidate labels evicted across iterations. */
  readonly evictedBranches: string[];
  /** Current target branch tip commit SHA before this chain. */
  currentTargetSha: string;
  /** Remaining candidate branches in the queue for this iteration. */
  queue: readonly MergeTrainCandidate[];
  /** Cumulative number of `verifyWith` check executions performed. */
  verificationRuns: number;
}

/**
 * Fetches `origin` and resolves the current commit SHA of `targetBranch` (preferring `refs/remotes/origin/<targetBranch>`).
 *
 * @param {string}            cwd          - Worktree directory path.
 * @param {string}            targetBranch - Target branch name configured on `GitMergeQueueNode`.
 * @param {GitWorktreeHandle} handle       - Active worktree handle providing fallback `baseRef`.
 *
 * @returns {Promise<string>} Resolved initial target branch commit SHA.
 */
async function resolveMergeTrainTargetSha(
  cwd: string,
  targetBranch: string,
  handle: GitWorktreeHandle,
): Promise<string> {
  await runGitCommand({ cwd, args: ['fetch', 'origin'], allowNonZeroExit: true });
  const targetLookup = await runGitCommand({
    cwd,
    args: ['rev-parse', '--verify', `refs/remotes/origin/${targetBranch}`],
    allowNonZeroExit: true,
  });
  if (targetLookup.exitCode === 0) {
    return targetLookup.stdout.trim();
  }
  const localBranchLookup = await runGitCommand({
    cwd,
    args: ['rev-parse', targetBranch],
    allowNonZeroExit: true,
  });
  return localBranchLookup.stdout.trim() || handle.baseRef;
}

/**
 * Verifies the tip of a cumulative speculative rebase chain `params.chain`, or binary-bisects `params.chain` on failure
 * to land the valid prefix and evict the first offending candidate.
 *
 * @param {VerifyOrBisectMergeTrainChainParams} params - Chain verification and bisection parameters and mutable queue state.
 *
 * @returns {Promise<void>} Resolves once `params` queue state is updated for the completed chain iteration.
 */
async function verifyOrBisectMergeTrainChain(
  params: VerifyOrBisectMergeTrainChainParams,
): Promise<void> {
  const { node, ctx, chain, conflictedIdx, landedBranches, evictedBranches } =
    params;
  const cwd = ctx.scopeHandle.worktreePath;
  const tipEntry = chain[chain.length - 1];
  if (tipEntry === undefined) {
    const first = params.queue[0];
    if (first !== undefined) evictedBranches.push(first.label);
    params.queue = params.queue.slice(1);
    return;
  }
  await runGitCommand({ cwd, args: ['reset', '--hard', tipEntry.rebasedSha] });
  params.verificationRuns += 1;
  const tipCheck = await evaluateWorktreeCheck(node.verifyWith, ctx);
  if (tipCheck.ok) {
    params.currentTargetSha = tipEntry.rebasedSha;
    for (const entry of chain) landedBranches.push(entry.candidate.label);
    const conflictedCandidate =
      conflictedIdx >= 0 ? params.queue[conflictedIdx] : undefined;
    if (conflictedCandidate !== undefined) {
      evictedBranches.push(conflictedCandidate.label);
    }
    params.queue =
      conflictedIdx >= 0 ? params.queue.slice(conflictedIdx + 1) : [];
    return;
  }
  const [badIdx, bisectRuns] = await gitMergeTrainBisect(
    chain,
    node.verifyWith,
    ctx,
  );
  params.verificationRuns += bisectRuns;
  const priorEntry = badIdx > 0 ? chain[badIdx - 1] : undefined;
  if (priorEntry !== undefined) {
    params.currentTargetSha = priorEntry.rebasedSha;
  }
  for (let j = 0; j < badIdx; j += 1) {
    const prefixEntry = chain[j];
    if (prefixEntry !== undefined) landedBranches.push(prefixEntry.candidate.label);
  }
  const badEntry = chain[badIdx];
  if (badEntry !== undefined) evictedBranches.push(badEntry.candidate.label);
  params.queue = params.queue.slice(badIdx + 1);
}

/**
 * Resets the worktree to `targetSha`, fast-forwards `refs/heads/<targetBranch>`, and pushes to `origin`.
 *
 * @param {string} cwd          - Worktree directory path.
 * @param {string} targetBranch - Target branch name configured on `GitMergeQueueNode`.
 * @param {string} targetSha    - Final verified commit SHA to fast-forward onto.
 *
 * @returns {Promise<void>} Resolves once the local and remote target branch refs are updated.
 */
async function fastForwardAndPushMergeTrainTarget(
  cwd: string,
  targetBranch: string,
  targetSha: string,
): Promise<void> {
  await runGitCommand({ cwd, args: ['reset', '--hard', targetSha] });
  await runGitCommand({
    cwd,
    args: ['update-ref', `refs/heads/${targetBranch}`, targetSha],
    allowNonZeroExit: true,
  });
  await runGitCommand({
    cwd,
    args: ['push', 'origin', `${targetSha}:refs/heads/${targetBranch}`],
    allowNonZeroExit: true,
  });
}

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
  const initialTargetSha = await resolveMergeTrainTargetSha(
    cwd,
    node.targetBranch,
    ctx.scopeHandle,
  );
  const state: VerifyOrBisectMergeTrainChainParams = {
    node,
    ctx,
    chain: [],
    conflictedIdx: -1,
    landedBranches: [],
    evictedBranches: [],
    currentTargetSha: initialTargetSha,
    queue: [...candidates],
    verificationRuns: 0,
  };
  while (state.queue.length > 0) {
    const [chain, conflictedIdx] = await buildCumulativeRebaseChain(
      cwd,
      state.currentTargetSha,
      state.queue,
    );
    state.chain = chain;
    state.conflictedIdx = conflictedIdx;
    await verifyOrBisectMergeTrainChain(state);
  }
  await fastForwardAndPushMergeTrainTarget(
    cwd,
    node.targetBranch,
    state.currentTargetSha,
  );
  return {
    targetBranch: node.targetBranch,
    headRef: state.currentTargetSha,
    landedBranches: state.landedBranches,
    evictedBranches: state.evictedBranches,
    verificationRuns: state.verificationRuns,
  };
}
