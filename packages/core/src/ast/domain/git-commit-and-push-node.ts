import type { BivariantCallback } from '../ast-foundation.types.js';
import type { BaseDomainStepASTNode } from '../base/base-domain-step-ast-node.js';
import type { EnvRef } from '../env-ref.js';
import type { GitWorktreeHandle } from './git-worktree-handle.js';
import type { NodeRunnerNode } from './node-runner-node.js';

/**
 * Passive AST node squashing, rebasing, verifying, and pushing a worktree branch (`git.commitAndPush`).
 *
 * Stages dirty working-tree changes in the active `GitWorktreeHandle`, commits them with `message(input)`,
 * and pushes to `branch(input)` using `runner`.
 *
 * @template TIn Validated step input type.
 */
export interface GitCommitAndPushNode<TIn = unknown>
  extends BaseDomainStepASTNode<'git:commit-and-push', TIn, void, GitWorktreeHandle> {
  /** Pure projection deriving the target remote branch name from `TIn`. */
  readonly branch: BivariantCallback<[input: TIn], string>;
  /** Pure projection deriving the commit message from `TIn`. */
  readonly message: BivariantCallback<[input: TIn], string>;
  /** Runner pool governing subprocess slot concurrency. */
  readonly runner: NodeRunnerNode;
  /** Optional environment variables or symbolic `EnvRef` bindings injected into git commands. */
  readonly env?: Readonly<Record<string, string | EnvRef>>;
}
