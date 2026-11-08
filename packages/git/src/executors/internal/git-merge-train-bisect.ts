import { execFile } from 'node:child_process';
import type {
  BaseCheckASTNode,
  CheckASTNode,
  CheckEvaluationResult,
  GitWorktreeHandle,
  NodeExecutor,
  StepExecutionContext,
} from '@paraharness/core';
import {
  MergeTrainStepInputSchema,
  type MergeTrainInputItem,
} from '../../schemas/git-receipts.schema.js';
import {
  buildIsolatedWorktreeGitEnv,
  runGitCommand,
} from './git-cli-runner.js';
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
export async function evaluateWorktreeCheck(
  checkNode: BaseCheckASTNode<string, GitWorktreeHandle>,
  ctx: StepExecutionContext<GitWorktreeHandle>,
): Promise<CheckEvaluationResult> {
  const registered = ctx.registry?.checks?.[
    checkNode.type as CheckASTNode['type']
  ] as
    | NodeExecutor<
        BaseCheckASTNode<string, GitWorktreeHandle>,
        void,
        CheckEvaluationResult,
        StepExecutionContext<GitWorktreeHandle>
      >
    | undefined;
  if (registered !== undefined) {
    return registered(checkNode, undefined, ctx);
  }
  if ('command' in checkNode && typeof checkNode.command === 'string') {
    const cmd = checkNode.command;
    const cwd = ctx.scopeHandle.worktreePath;
    const env = buildIsolatedWorktreeGitEnv(cwd);
    return new Promise<CheckEvaluationResult>((resolve) => {
      execFile(
        'sh',
        ['-c', cmd],
        { cwd, env, signal: ctx.signal },
        (err, stdout, stderr) => {
          const ok = err === null;
          const msg = (
            stderr ||
            stdout ||
            (err?.message ?? 'Check failed')
          ).trim();
          resolve({ ok, deficits: ok ? [] : [msg] });
        },
      );
    });
  }
  throw new Error(
    `No CheckExecutor registered for '${checkNode.type}' (id '${checkNode.id}').`,
  );
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
export async function extractMergeTrainCandidates(
  input: unknown,
  handle: GitWorktreeHandle,
  maxBatchSize: number,
): Promise<readonly MergeTrainCandidate[]> {
  const parsed = MergeTrainStepInputSchema.safeParse(input);
  const rawItems: readonly MergeTrainInputItem[] = parsed.success
    ? Array.isArray(parsed.data)
      ? parsed.data
      : (parsed.data.candidates ??
        parsed.data.branches ??
        parsed.data.refs ??
        parsed.data.receipts ??
        [])
    : [];
  if (rawItems.length === 0) {
    const fallbackHead = handle.headRef ?? handle.baseRef;
    return Object.freeze([
      {
        label: handle.branchName ?? fallbackHead,
        headSha: fallbackHead,
        baseSha: handle.baseRef,
      },
    ]);
  }
  const candidates: MergeTrainCandidate[] = [];
  const limit = Math.min(rawItems.length, Math.max(1, maxBatchSize));
  for (let idx = 0; idx < limit; idx += 1) {
    const raw = rawItems[idx];
    if (raw === undefined) continue;
    const label =
      typeof raw === 'string'
        ? raw
        : (raw.branchName ?? raw.ref ?? raw.headRef ?? '');
    const refInput = typeof raw === 'string' ? raw : (raw.headRef ?? label);
    const headSha = (
      await runGitCommand({
        cwd: handle.worktreePath,
        args: ['rev-parse', refInput],
      })
    ).stdout.trim();
    const explicitBase = typeof raw === 'string' ? undefined : raw.baseRef;
    const parentLookup = (
      await runGitCommand({
        cwd: handle.worktreePath,
        args: ['rev-parse', `${headSha}^`],
        allowNonZeroExit: true,
      })
    ).stdout.trim();
    const baseSha = (explicitBase ?? parentLookup) || handle.baseRef;
    candidates.push({ label, headSha, baseSha });
  }
  return Object.freeze(candidates);
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
export async function buildCumulativeRebaseChain(
  cwd: string,
  currentTargetSha: string,
  queue: readonly MergeTrainCandidate[],
): Promise<readonly [readonly MergeTrainChainEntry[], number]> {
  const chain: MergeTrainChainEntry[] = [];
  for (let i = 0; i < queue.length; i += 1) {
    const cand = queue[i];
    if (cand === undefined) break;
    const prevEntry = chain[chain.length - 1];
    const prevSha = prevEntry === undefined ? currentTargetSha : prevEntry.rebasedSha;
    await runGitCommand({ cwd, args: ['checkout', '--detach', '--force', cand.headSha] });
    const rebaseOutput = await runGitCommand({ cwd, args: ['rebase', '--onto', prevSha, cand.baseSha, 'HEAD'], allowNonZeroExit: true });
    if (rebaseOutput.exitCode !== 0) {
      await runGitCommand({ cwd, args: ['rebase', '--abort'], allowNonZeroExit: true });
      return [Object.freeze(chain), i] as const;
    }
    const rebasedSha = (await runGitCommand({ cwd, args: ['rev-parse', 'HEAD'] })).stdout.trim();
    chain.push({ candidate: cand, rebasedSha });
  }
  return [Object.freeze(chain), -1] as const;
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
export async function gitMergeTrainBisect(
  chain: readonly MergeTrainChainEntry[],
  verifyWith: BaseCheckASTNode<string, GitWorktreeHandle>,
  ctx: StepExecutionContext<GitWorktreeHandle>,
): Promise<readonly [number, number]> {
  let low = 0;
  let high = chain.length - 1;
  let runs = 0;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const midEntry = chain[mid];
    if (midEntry === undefined) break;
    await runGitCommand({ cwd: ctx.scopeHandle.worktreePath, args: ['reset', '--hard', midEntry.rebasedSha] });
    runs += 1;
    const checkOutcome = await evaluateWorktreeCheck(verifyWith, ctx);
    if (checkOutcome.ok) low = mid + 1;
    else high = mid;
  }
  return [low, runs] as const;
}
