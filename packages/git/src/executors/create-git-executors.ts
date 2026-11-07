import type {
  GitCowWorktreeNode,
  GitPatchEquivalenceNode,
  GitPublicSurfaceCrossTesterNode,
  GitWorktreeHandle,
  RuntimeExecutorRegistrySlice,
  StepExecutionContext,
} from '@harness-dsl/core';
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
 * Constructs a fresh `RuntimeExecutorRegistrySlice` registering all `@harness-dsl/git` scope, step, check, hook, cross-verifier, and tool executors.
 *
 * Mounts `git:cow-worktree`, `git:commit-and-push`, `git:merge-queue`, `git:clean-working-tree`,
 * `git:snapshot-and-reset`, `git:keep-worktree`, `git:discard-branch`, `git:public-surface-cross-tester`,
 * `git:patch-equivalence`, `git:ref-reader-tool`, and `git:candidate-comparison-tool`.
 *
 * @returns {RuntimeExecutorRegistrySlice} Frozen registry slice for `@harness-dsl/git`.
 */
export function createGitExecutors(): RuntimeExecutorRegistrySlice {
  return Object.freeze<RuntimeExecutorRegistrySlice>({
    scopes: Object.freeze({
      'git:cow-worktree': (node) =>
        new GitCowWorktreeScopeDriver(node as GitCowWorktreeNode) as never,
    }),
    steps: Object.freeze({
      'git:commit-and-push': (node, input, ctx) =>
        executeGitCommitAndPushStep(
          node,
          input,
          ctx as StepExecutionContext<GitWorktreeHandle>,
        ),
      'git:merge-queue': (node, input, ctx) =>
        executeGitMergeQueueStep(
          node,
          input,
          ctx as StepExecutionContext<GitWorktreeHandle>,
        ),
    }),
    checks: Object.freeze({
      'git:clean-working-tree': (node, input, ctx) =>
        executeGitCleanWorkingTreeCheck(
          node,
          input,
          ctx as StepExecutionContext<GitWorktreeHandle>,
        ),
    }),
    abortHooks: Object.freeze({
      'git:snapshot-and-reset': (node, input, ctx) =>
        executeGitSnapshotAndResetHook(
          node,
          input as never,
          ctx as StepExecutionContext<GitWorktreeHandle>,
        ),
    }),
    rewindHooks: Object.freeze({
      'git:keep-worktree': (node, input, ctx) =>
        executeGitKeepWorktreeHook(
          node,
          input as never,
          ctx as StepExecutionContext<GitWorktreeHandle>,
        ),
      'git:discard-branch': (node, input, ctx) =>
        executeGitDiscardBranchHook(
          node,
          input as never,
          ctx as StepExecutionContext<GitWorktreeHandle>,
        ),
    }),
    crossVerifiers: Object.freeze({
      'git:public-surface-cross-tester': (node, candidates, ctx) =>
        executeGitPublicSurfaceCrossTester(
          node as GitPublicSurfaceCrossTesterNode,
          candidates as never,
          ctx as StepExecutionContext<GitWorktreeHandle>,
        ),
      'git:patch-equivalence': (node, candidates, ctx) =>
        executeGitPatchEquivalence(
          node as GitPatchEquivalenceNode,
          candidates as never,
          ctx as StepExecutionContext<GitWorktreeHandle>,
        ),
    }),
    tools: Object.freeze({
      'git:ref-reader-tool': createGitRefReaderToolDrivers() as never,
      'git:candidate-comparison-tool':
        createGitCandidateComparisonToolDrivers() as never,
    }),
  });
}
