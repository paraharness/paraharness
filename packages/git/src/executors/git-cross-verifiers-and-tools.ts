import { createHash } from 'node:crypto';
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
import picomatch from 'picomatch';
import { runGitCommand } from './internal/git-cli-runner.js';
import {
  collectCandidateBoundaryTests,
  runTransplantedTestsOnTarget,
} from './internal/git-tool-and-verifier-helpers.js';
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
  const matchers: Array<(candidatePath: string) => boolean> = [];
  for (const part of Object.values(node.partitionMap.mapping)) {
    for (const glob of part.boundaryGlobs) matchers.push(picomatch(glob, { dot: true }));
  }
  const isBoundaryPath = (candidatePath: string): boolean => {
    for (const isMatch of matchers) if (isMatch(candidatePath)) return true;
    return false;
  };
  const runVerifier = async (): Promise<Readonly<Record<number, unknown>>> => {
    const testsByBranch = new Map<number, ReadonlyMap<string, string>>();
    for (const cand of candidates) {
      testsByBranch.set(cand.branchIndex, await collectCandidateBoundaryTests(cand, isBoundaryPath));
    }
    const reports: Record<number, unknown> = {};
    for (const target of candidates) {
      const mergedTests = new Map<string, string>();
      for (const [sourceIdx, testMap] of testsByBranch) {
        if (sourceIdx === target.branchIndex) continue;
        for (const [relPath, content] of testMap) mergedTests.set(relPath, content);
      }
      const rawReport = await runTransplantedTestsOnTarget(target, mergedTests);
      reports[target.branchIndex] = node.reportSchema.parse(rawReport);
    }
    return Object.freeze(reports);
  };
  if (node.runner !== undefined && typeof ctx.getRunner === 'function') {
    return ctx.getRunner(node.runner).withSlot(runVerifier, ctx.signal);
  }
  return runVerifier();
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
    const headSha = typeof cand.scopeReceipt['headRef'] === 'string'
      ? cand.scopeReceipt['headRef']
      : (cand.scopeHandle.headRef ?? cand.scopeHandle.baseRef);
    const rawDiff = (await runGitCommand({ cwd: cand.scopeHandle.worktreePath, args: ['diff', '--no-ext-diff', '--no-color', cand.scopeHandle.baseRef, headSha] })).stdout;
    const keptLines: string[] = [];
    for (const line of rawDiff.split('\n')) {
      if (!line.startsWith('index ')) keptLines.push(line.trimEnd());
    }
    const digest = createHash('sha256').update(keptLines.join('\n').trim(), 'utf8').digest('hex');
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
    reports[cand.branchIndex] = node.reportSchema.parse({ equivalenceGroupIndex, equivalentBranchIndices, normalizedPatchDigest: digest });
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
