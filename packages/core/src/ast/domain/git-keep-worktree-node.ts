import type { BaseScopeRewindHookASTNode } from '../base/base-scope-rewind-hook-ast-node.js';
import type { GitWorktreeHandle } from './git-worktree-handle.js';

/**
 * Passive AST node preserving a worktree's current working tree and topology overlay in-place
 * across a signal-driven `.rewindTo()` (`git.keepWorktree`).
 *
 * Leaves both the physical git worktree files and the run's uncommitted Copy-on-Write topology
 * overlay intact when rewinding to an earlier flow step.
 */
export interface GitKeepWorktreeNode
  extends BaseScopeRewindHookASTNode<'git:keep-worktree', GitWorktreeHandle> {
  /** Preserves uncommitted run topology overlay mutations across the rewind. */
  readonly resetsRunOverlay: false;
}
