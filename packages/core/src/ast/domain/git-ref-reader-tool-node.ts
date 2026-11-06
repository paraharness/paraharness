import type { BaseToolASTNode } from '../base/base-tool-ast-node.js';
import type { GitWorktreeHandle } from './git-worktree-handle.js';
import type { NodeRunnerNode } from './node-runner-node.js';

/**
 * Passive AST node for read-only git object store inspection tools (`git.refReaderTools`).
 *
 * Allows actors to inspect `refs/harness/aborted/<run-id>/<stepExecId>` snapshots via
 * `readRefFile`, `diffRefs`, and `listRefFiles`.
 *
 * @template THandle Isolation scope handle type.
 */
export interface GitRefReaderToolNode<THandle = GitWorktreeHandle>
  extends BaseToolASTNode<'git:ref-reader-tool', 'declared', THandle> {
  /** Runner pool governing git subprocess slot concurrency. */
  readonly runner: NodeRunnerNode;
}
