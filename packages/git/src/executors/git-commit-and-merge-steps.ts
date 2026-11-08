import type {
  GitCommitAndPushNode,
  GitMergeQueueNode,
  GitWorktreeHandle,
  StepExecutionContext,
} from '@metaharness/core';
import { extractMergeTrainCandidates } from './internal/git-merge-train-bisect.js';
import { executeBatchMergeTrainQueue } from './internal/merge-train-runner.js';
import { runSquashRebaseAndPush } from './internal/squash-rebase-and-push.js';

/**
 * Executes a `GitCommitAndPushNode` (`git.commitAndPush`) step against the active `GitWorktreeHandle`.
 *
 * Acquires a concurrency slot from `node.runner`, flushes uncommitted edits, squashes over `baseRef`,
 * rebases onto `origin/${resolvedBaseBranch}`, runs `verifyWith`, and pushes with `--force-with-lease`.
 *
 * @template TIn Step input payload type.
 *
 * @param {GitCommitAndPushNode<TIn>}               node  - Passive commit-and-push step AST node.
 * @param {TIn}                                     input - Step input payload.
 * @param {StepExecutionContext<GitWorktreeHandle>} ctx   - Active step execution context.
 *
 * @returns {Promise<void>} Resolves once the branch is pushed and `rootHandle` lineage is updated.
 */
export async function executeGitCommitAndPushStep<TIn = unknown>(
  node: GitCommitAndPushNode<TIn>,
  input: TIn,
  ctx: StepExecutionContext<GitWorktreeHandle>,
): Promise<void> {
  const parsedInput = node.inputSchema !== undefined ? node.inputSchema.parse(input) : input;
  const runStep = (): Promise<void> =>
    runSquashRebaseAndPush(node as GitCommitAndPushNode<unknown>, parsedInput, ctx);
  if (node.runner !== undefined && typeof ctx.getRunner === 'function') {
    const runner = ctx.getRunner(node.runner);
    await runner.withSlot(runStep, ctx.signal);
    return;
  }
  await runStep();
}

/**
 * Executes a `GitMergeQueueNode` (`git.mergeQueue`) step using speculative cumulative rebase chains.
 *
 * Combines up to `node.maxBatchSize` candidate branches onto `node.targetBranch`, runs `node.verifyWith`
 * once on the tip $R_k$, and binary-bisects on verification failure to isolate and evict offending branches.
 *
 * @template TIn  Step input payload type.
 * @template TOut Step output payload type.
 *
 * @param {GitMergeQueueNode<TIn, TOut>}            node  - Passive merge-queue step AST node.
 * @param {TIn}                                     input - Step input payload containing candidate branches or refs.
 * @param {StepExecutionContext<GitWorktreeHandle>} ctx   - Active step execution context.
 *
 * @returns {Promise<TOut>} Validated merge-train execution summary.
 */
export async function executeGitMergeQueueStep<TIn = unknown, TOut = unknown>(
  node: GitMergeQueueNode<TIn, TOut>,
  input: TIn,
  ctx: StepExecutionContext<GitWorktreeHandle>,
): Promise<TOut> {
  const parsedInput = node.inputSchema !== undefined ? node.inputSchema.parse(input) : input;
  const candidates = await extractMergeTrainCandidates(parsedInput, ctx.scopeHandle, node.maxBatchSize);
  const outcome = await executeBatchMergeTrainQueue(
    node as GitMergeQueueNode<unknown, unknown>,
    candidates,
    ctx,
  );
  if (node.outputSchema !== undefined) {
    return node.outputSchema.parse(outcome);
  }
  return outcome as TOut;
}
