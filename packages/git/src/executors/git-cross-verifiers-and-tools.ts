import type {
  CrossVerifierBranchCandidate,
  GitCandidateComparisonToolNode,
  GitPatchEquivalenceNode,
  GitPublicSurfaceCrossTesterNode,
  GitRefReaderToolNode,
  GitWorktreeHandle,
  StepExecutionContext,
  ToolDriver,
} from '@harness-dsl/core';
import { runGitCommand } from './internal/git-cli-runner.js';
import { runPublicSurfaceCrossVerification } from './internal/git-cross-test-import-scanner.js';
import {
  dispatchCandidateComparisonToolCall,
  dispatchRefReaderToolCall,
} from './internal/git-tool-dispatchers.js';

/**
 * Executes a `GitPublicSurfaceCrossTesterNode` (`git.publicSurfaceCrossTester`) across speculative candidates.
 *
 * Collects boundary-only tests from each candidate and transplants them into sibling candidates inside a checkpoint sandbox.
 *
 * @param {GitPublicSurfaceCrossTesterNode<unknown>}                       node       - Public-surface cross-tester AST node.
 * @param {ReadonlyArray<CrossVerifierBranchCandidate<GitWorktreeHandle>>} candidates - Surviving speculative candidate branches.
 * @param {StepExecutionContext<GitWorktreeHandle>}                        ctx        - Active step execution context.
 *
 * @returns {Promise<Readonly<Record<number, unknown>>>} Per-branch cross-testing report indexed by `branchIndex`.
 */
export async function executeGitPublicSurfaceCrossTester(
  node: GitPublicSurfaceCrossTesterNode<unknown>,
  candidates: ReadonlyArray<CrossVerifierBranchCandidate<GitWorktreeHandle>>,
  ctx: StepExecutionContext<GitWorktreeHandle>,
): Promise<Readonly<Record<number, unknown>>> {
  const runVerifier = (): Promise<Readonly<Record<number, unknown>>> =>
    runPublicSurfaceCrossVerification(node, candidates);
  if (node.runner !== undefined && typeof ctx.getRunner === 'function') {
    return ctx.getRunner(node.runner).withSlot(runVerifier, ctx.signal);
  }
  return runVerifier();
}

/**
 * Computes the normalized `git patch-id --stable` digest for a single speculative candidate branch.
 *
 * @param {CrossVerifierBranchCandidate<GitWorktreeHandle>} candidate - Speculative candidate descriptor.
 *
 * @returns {Promise<string>} Stable normalized patch digest, or `'EMPTY_PATCH'` when the diff is empty.
 */
async function computeCandidatePatchDigest(
  candidate: CrossVerifierBranchCandidate<GitWorktreeHandle>,
): Promise<string> {
  const cwd = candidate.scopeHandle.worktreePath;
  const headSha = typeof candidate.scopeReceipt['headRef'] === 'string'
    ? candidate.scopeReceipt['headRef']
    : (candidate.scopeHandle.headRef ?? candidate.scopeHandle.baseRef);
  const diffOutput = await runGitCommand({
    cwd,
    args: ['diff', '--no-ext-diff', '--no-color', candidate.scopeHandle.baseRef, headSha],
  });
  if (diffOutput.stdout.trim().length === 0) return 'EMPTY_PATCH';
  const patchOutput = await runGitCommand({
    cwd,
    args: ['patch-id', '--stable'],
    stdin: diffOutput.stdout,
  });
  return patchOutput.stdout.trim().split(/\s+/)[0] || 'EMPTY_PATCH';
}

/**
 * Executes a `GitPatchEquivalenceNode` (`git.patchEquivalence`) across speculative worktree candidates.
 *
 * Computes normalized patch digests relative to `baseRef` and groups equivalent candidate branch indices.
 *
 * @param {GitPatchEquivalenceNode<unknown>}                               node       - Patch-equivalence cross-verifier AST node.
 * @param {ReadonlyArray<CrossVerifierBranchCandidate<GitWorktreeHandle>>} candidates - Surviving speculative candidate branches.
 * @param {StepExecutionContext<GitWorktreeHandle>}                        _ctx       - Active step execution context.
 *
 * @returns {Promise<Readonly<Record<number, unknown>>>} Per-branch patch equivalence report indexed by `branchIndex`.
 */
export async function executeGitPatchEquivalence(
  node: GitPatchEquivalenceNode<unknown>,
  candidates: ReadonlyArray<CrossVerifierBranchCandidate<GitWorktreeHandle>>,
  _ctx: StepExecutionContext<GitWorktreeHandle>,
): Promise<Readonly<Record<number, unknown>>> {
  const digestByBranch = new Map<number, string>();
  const branchesByDigest = new Map<string, number[]>();
  const groupIndexByDigest = new Map<string, number>();
  for (const cand of candidates) {
    const digest = await computeCandidatePatchDigest(cand);
    digestByBranch.set(cand.branchIndex, digest);
    const existingGroup = branchesByDigest.get(digest);
    if (existingGroup !== undefined) existingGroup.push(cand.branchIndex);
    else {
      groupIndexByDigest.set(digest, branchesByDigest.size);
      branchesByDigest.set(digest, [cand.branchIndex]);
    }
  }
  const reports: Record<number, unknown> = {};
  for (const cand of candidates) {
    const digest = digestByBranch.get(cand.branchIndex) ?? '';
    const equivalenceGroupIndex = groupIndexByDigest.get(digest) ?? 0;
    const equivalentBranchIndices = branchesByDigest.get(digest) ?? [cand.branchIndex];
    reports[cand.branchIndex] = node.reportSchema.parse({
      equivalenceGroupIndex,
      equivalentBranchIndices,
      normalizedPatchDigest: digest,
    });
  }
  return Object.freeze(reports);
}

/**
 * Creates the `ToolDriver` handling `GitRefReaderToolNode` (`git:ref-reader-tool`) invocations.
 *
 * Declares zero scope effects (`describeEffects: () => []`) and dispatches `readRefFile`, `diffRefs`, and `listRefFiles`.
 *
 * @returns {ToolDriver<GitRefReaderToolNode<GitWorktreeHandle>, GitWorktreeHandle>} Stateless ref-reader tool driver.
 */
export function createGitRefReaderToolDrivers(): ToolDriver<
  GitRefReaderToolNode<GitWorktreeHandle>,
  GitWorktreeHandle
> {
  return Object.freeze<ToolDriver<GitRefReaderToolNode<GitWorktreeHandle>, GitWorktreeHandle>>({
    describeEffects: () => [],
    execute: (
      node: GitRefReaderToolNode<GitWorktreeHandle>,
      args: unknown,
      ctx: StepExecutionContext<GitWorktreeHandle>,
    ) => dispatchRefReaderToolCall(node, args, ctx),
  });
}

/**
 * Creates the `ToolDriver` handling `GitCandidateComparisonToolNode` (`git:candidate-comparison-tool`) invocations.
 *
 * Declares zero scope effects (`describeEffects: () => []`) and dispatches `diffCandidates`, `readCandidateFile`, and `evalInCandidates`.
 *
 * @returns {ToolDriver<GitCandidateComparisonToolNode<GitWorktreeHandle>, GitWorktreeHandle>} Stateless candidate comparison tool driver.
 */
export function createGitCandidateComparisonToolDrivers(): ToolDriver<
  GitCandidateComparisonToolNode<GitWorktreeHandle>,
  GitWorktreeHandle
> {
  return Object.freeze<ToolDriver<GitCandidateComparisonToolNode<GitWorktreeHandle>, GitWorktreeHandle>>({
    describeEffects: () => [],
    execute: (
      node: GitCandidateComparisonToolNode<GitWorktreeHandle>,
      args: unknown,
      ctx: StepExecutionContext<GitWorktreeHandle>,
    ) => dispatchCandidateComparisonToolCall(node, args, ctx),
  });
}
