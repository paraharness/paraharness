import type {
  BaseCheckASTNode,
  CheckEvaluationResult,
  GitWorktreeHandle,
  StepExecutionContext,
} from '@harness-dsl/core';
import {
  buildCumulativeRebaseChain as buildRebaseChain,
  evaluateWorktreeCheck as evaluateCheck,
  extractMergeTrainCandidates as extractCandidates,
  gitMergeTrainBisect,
} from './git-merge-train-bisect.js';
import type { MergeTrainCandidate } from './merge-train-candidate.js';
import type { MergeTrainChainEntry } from './merge-train-chain-entry.js';

/**
 * Evaluates a deterministic `CheckASTNode` against the active `GitWorktreeHandle`.
 *
 * Dispatches through `ctx.registry.checks` when registered, or executes `command` in the worktree environment.
 *
 * @param {BaseCheckASTNode<string, GitWorktreeHandle>} checkNode - Check AST node to evaluate.
 * @param {StepExecutionContext<GitWorktreeHandle>}     ctx       - Active step execution context.
 *
 * @returns {Promise<CheckEvaluationResult>} Check pass/fail evaluation outcome.
 */
export function evaluateWorktreeCheck(
  checkNode: BaseCheckASTNode<string, GitWorktreeHandle>,
  ctx: StepExecutionContext<GitWorktreeHandle>,
): Promise<CheckEvaluationResult> {
  return evaluateCheck(checkNode, ctx);
}

/**
 * Normalizes candidate branch inputs for a batch merge-train step up to `maxBatchSize`.
 *
 * Resolves branch names, refs, or receipt objects into `{ label, headSha, baseSha }` descriptors.
 *
 * @param {unknown}           input        - Step input containing candidate branches/refs or `undefined`.
 * @param {GitWorktreeHandle} handle       - Active worktree handle used for ref resolution.
 * @param {number}            maxBatchSize - Maximum number of candidates per batch.
 *
 * @returns {Promise<readonly MergeTrainCandidate[]>} Normalized merge-train candidates.
 */
export function extractMergeTrainCandidates(
  input: unknown,
  handle: GitWorktreeHandle,
  maxBatchSize: number,
): Promise<readonly MergeTrainCandidate[]> {
  return extractCandidates(input, handle, maxBatchSize);
}

/**
 * Constructs a cumulative speculative rebase chain $R_1 \dots R_m$ onto `currentTargetSha`.
 *
 * Halts and returns `[chain, conflictedIndex]` if a candidate fails to rebase cleanly onto the prior tip.
 *
 * @param {string}                          cwd              - Worktree directory path.
 * @param {string}                          currentTargetSha - Base commit SHA for $R_1$.
 * @param {readonly MergeTrainCandidate[]}  queue            - Remaining candidate branches to chain.
 *
 * @returns {Promise<readonly [readonly MergeTrainChainEntry[], number]>} Tuple of `[chain, conflictedIndex]`.
 */
export function buildCumulativeRebaseChain(
  cwd: string,
  currentTargetSha: string,
  queue: readonly MergeTrainCandidate[],
): Promise<readonly [readonly MergeTrainChainEntry[], number]> {
  return buildRebaseChain(cwd, currentTargetSha, queue);
}

/**
 * Binary-bisects a cumulative rebase chain $R_1 \dots R_m$ whose tip $R_m$ failed `verifyWith`.
 *
 * Isolates the first offending candidate index in $O(\log m)$ verification checks.
 *
 * @param {readonly MergeTrainChainEntry[]}             chain      - Cumulative speculative rebase chain entries.
 * @param {BaseCheckASTNode<string, GitWorktreeHandle>} verifyWith - Verification check AST node.
 * @param {StepExecutionContext<GitWorktreeHandle>}     ctx        - Active step execution context.
 *
 * @returns {Promise<readonly [number, number]>} Tuple of `[firstFailingIndex, verificationRunsUsed]`.
 */
export function bisectFailingRebaseChain(
  chain: readonly MergeTrainChainEntry[],
  verifyWith: BaseCheckASTNode<string, GitWorktreeHandle>,
  ctx: StepExecutionContext<GitWorktreeHandle>,
): Promise<readonly [number, number]> {
  return gitMergeTrainBisect(chain, verifyWith, ctx);
}
