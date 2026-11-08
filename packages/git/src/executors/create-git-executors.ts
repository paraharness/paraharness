import type {
  AbortHookExecutionInput,
  BranchableScope,
  CrossVerifierBranchCandidate,
  GitCandidateComparisonToolNode,
  GitCleanWorkingTreeNode,
  GitCommitAndPushNode,
  GitCowWorktreeNode,
  GitDiscardBranchNode,
  GitKeepWorktreeNode,
  GitMergeQueueNode,
  GitPatchEquivalenceNode,
  GitPublicSurfaceCrossTesterNode,
  GitRefReaderToolNode,
  GitSnapshotAndResetNode,
  GitWorktreeHandle,
  RewindHookExecutionInput,
  RuntimeExecutorRegistrySlice,
  StepExecutionContext,
  ToolDriver,
} from '@paraharness/core';
import {
  executeGitCommitAndPushStep,
  executeGitMergeQueueStep,
} from './git-commit-and-merge-steps.js';
import { GitCowWorktreeScopeDriver } from './git-cow-worktree-scope.js';
import {
  createGitCandidateComparisonToolDrivers,
  createGitRefReaderToolDrivers,
  executeGitPatchEquivalence,
  executeGitPublicSurfaceCrossTester,
} from './git-cross-verifiers-and-tools.js';
import {
  executeGitCleanWorkingTreeCheck,
  executeGitDiscardBranchHook,
  executeGitKeepWorktreeHook,
  executeGitSnapshotAndResetHook,
} from './git-hooks-and-checks.js';

/**
 * Constructs a fresh `RuntimeExecutorRegistrySlice` registering all `@paraharness/git` scope, step, check, hook, cross-verifier, and tool executors.
 *
 * Mounts `git:cow-worktree`, `git:commit-and-push`, `git:merge-queue`, `git:clean-working-tree`,
 * `git:snapshot-and-reset`, `git:keep-worktree`, `git:discard-branch`, `git:public-surface-cross-tester`,
 * `git:patch-equivalence`, `git:ref-reader-tool`, and `git:candidate-comparison-tool`.
 *
 * @returns {RuntimeExecutorRegistrySlice} Frozen registry slice for `@paraharness/git`.
 */
export function createGitExecutors(): RuntimeExecutorRegistrySlice {
  return Object.freeze<RuntimeExecutorRegistrySlice>({
    scopes: Object.freeze({
      'git:cow-worktree': (node: GitCowWorktreeNode) =>
        new GitCowWorktreeScopeDriver(node) as BranchableScope<
          unknown,
          Record<string, unknown>,
          Record<string, unknown>
        >,
    }),
    steps: Object.freeze({
      'git:commit-and-push': (node: GitCommitAndPushNode, input: unknown, ctx: StepExecutionContext<unknown>) =>
        executeGitCommitAndPushStep(node, input, ctx as StepExecutionContext<GitWorktreeHandle>),
      'git:merge-queue': (node: GitMergeQueueNode, input: unknown, ctx: StepExecutionContext<unknown>) =>
        executeGitMergeQueueStep(node, input, ctx as StepExecutionContext<GitWorktreeHandle>),
    }),
    checks: Object.freeze({
      'git:clean-working-tree': (node: GitCleanWorkingTreeNode, input: void, ctx: StepExecutionContext<unknown>) =>
        executeGitCleanWorkingTreeCheck(node, input, ctx as StepExecutionContext<GitWorktreeHandle>),
    }),
    abortHooks: Object.freeze({
      'git:snapshot-and-reset': (
        node: GitSnapshotAndResetNode,
        input: AbortHookExecutionInput,
        ctx: StepExecutionContext<unknown>,
      ) =>
        executeGitSnapshotAndResetHook(
          node,
          input as AbortHookExecutionInput<GitWorktreeHandle>,
          ctx as StepExecutionContext<GitWorktreeHandle>,
        ),
    }),
    rewindHooks: Object.freeze({
      'git:keep-worktree': (
        node: GitKeepWorktreeNode,
        input: RewindHookExecutionInput,
        ctx: StepExecutionContext<unknown>,
      ) =>
        executeGitKeepWorktreeHook(
          node,
          input as RewindHookExecutionInput<GitWorktreeHandle>,
          ctx as StepExecutionContext<GitWorktreeHandle>,
        ),
      'git:discard-branch': (
        node: GitDiscardBranchNode,
        input: RewindHookExecutionInput,
        ctx: StepExecutionContext<unknown>,
      ) =>
        executeGitDiscardBranchHook(
          node,
          input as RewindHookExecutionInput<GitWorktreeHandle>,
          ctx as StepExecutionContext<GitWorktreeHandle>,
        ),
    }),
    crossVerifiers: Object.freeze({
      'git:public-surface-cross-tester': (
        node: GitPublicSurfaceCrossTesterNode<unknown>,
        candidates: ReadonlyArray<CrossVerifierBranchCandidate>,
        ctx: StepExecutionContext<unknown>,
      ) =>
        executeGitPublicSurfaceCrossTester(
          node,
          candidates as ReadonlyArray<CrossVerifierBranchCandidate<GitWorktreeHandle>>,
          ctx as StepExecutionContext<GitWorktreeHandle>,
        ),
      'git:patch-equivalence': (
        node: GitPatchEquivalenceNode<unknown>,
        candidates: ReadonlyArray<CrossVerifierBranchCandidate>,
        ctx: StepExecutionContext<unknown>,
      ) =>
        executeGitPatchEquivalence(
          node,
          candidates as ReadonlyArray<CrossVerifierBranchCandidate<GitWorktreeHandle>>,
          ctx as StepExecutionContext<GitWorktreeHandle>,
        ),
    }),
    tools: Object.freeze({
      'git:ref-reader-tool': createGitRefReaderToolDrivers() as ToolDriver<GitRefReaderToolNode, unknown>,
      'git:candidate-comparison-tool':
        createGitCandidateComparisonToolDrivers() as ToolDriver<GitCandidateComparisonToolNode, unknown>,
    }),
  });
}
