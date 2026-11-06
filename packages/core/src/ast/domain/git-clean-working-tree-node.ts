import type { BaseCheckASTNode } from '../base/base-check-ast-node.js';
import type { GitWorktreeHandle } from './git-worktree-handle.js';

/**
 * Passive AST node verifying that a `GitWorktreeHandle` has zero unresolved conflict paths or paired conflict markers.
 *
 * Enforced automatically after conflicted 3-way merges or rebases to prevent unresolved conflict
 * markers (`<<<<<<<`, `=======`, `>>>>>>>`) from landing on parent or upstream branches.
 *
 * @template THandle Worktree scope handle type.
 */
export interface GitCleanWorkingTreeNode<THandle = GitWorktreeHandle>
  extends BaseCheckASTNode<'git:clean-working-tree', THandle> {}
