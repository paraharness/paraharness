import type { BaseAbortHookASTNode } from '../base/base-abort-hook-ast-node.js';
import type { GitAbortMeta } from './git-abort-meta.js';
import type { GitWorktreeHandle } from './git-worktree-handle.js';

/**
 * Passive AST node snapshotting an aborted worktree to `refs/harness/aborted/<run-id>/<stepExecId>`
 * and resetting the working tree to `handle.baseRef` (`git.snapshotAndReset`).
 *
 * Preserves the aborted step's dirty working tree as an immutable git commit ref for downstream
 * `git.refReaderTools` inspection while restoring the workspace to a clean baseline for replacement steps.
 */
export interface GitSnapshotAndResetNode
  extends BaseAbortHookASTNode<'git:snapshot-and-reset', GitWorktreeHandle, GitAbortMeta> {}
