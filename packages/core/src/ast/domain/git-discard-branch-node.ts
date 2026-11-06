import type { BaseScopeRewindHookASTNode } from '../base/base-scope-rewind-hook-ast-node.js';
import type { GitWorktreeHandle } from './git-worktree-handle.js';

/**
 * Passive AST node resetting a worktree to `targetStepBaseScopeCheckpoint` and clearing uncommitted
 * run topology overlay mutations during `.rewindTo()` (`git.resetWorktree` / `git.discardBranch`).
 *
 * Restores both the physical git working tree and the run's Copy-on-Write topology overlay
 * back to the checkpoint recorded at the entry of the rewind target step.
 */
export interface GitDiscardBranchNode
  extends BaseScopeRewindHookASTNode<'git:discard-branch', GitWorktreeHandle> {
  /** Resets uncommitted run topology overlay mutations back to the run-start/prerequisite base. */
  readonly resetsRunOverlay: true;
}
