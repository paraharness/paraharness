import type { BaseToolASTNode } from '../base/base-tool-ast-node.js';
import type { GitWorktreeHandle } from './git-worktree-handle.js';
import type { NodeRunnerNode } from './node-runner-node.js';

/**
 * Passive AST node for speculative candidate comparison and benchmark tools (`git.candidateComparisonTools`).
 *
 * Exposes `diffCandidates`, `readCandidateFile`, and checkpoint-sandboxed `evalInCandidates`
 * over `refs/harness/candidates/<run-id>/<branch-index>` and live candidate worktrees.
 *
 * @template THandle Isolation scope handle type.
 */
export interface GitCandidateComparisonToolNode<THandle = GitWorktreeHandle>
  extends BaseToolASTNode<'git:candidate-comparison-tool', 'declared', THandle> {
  /** Runner pool governing git and benchmark subprocess slot concurrency. */
  readonly runner: NodeRunnerNode;
}
