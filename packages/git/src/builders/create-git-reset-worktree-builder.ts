import type { AstBuilder, GitDiscardBranchNode } from '@paraharness/core';

/**
 * Creates a fluent `AstBuilder<GitDiscardBranchNode>` (`git.resetWorktree()`).
 *
 * Compiles into a passive `GitDiscardBranchNode` (`type: 'git:discard-branch'`, `resetsRunOverlay: true`)
 * that restores the worktree to `targetStepBaseScopeCheckpoint` and resets the run topology overlay on rewind.
 *
 * @param {string} [id='git-reset-worktree'] - Optional custom identifier for the rewind hook node.
 *
 * @returns {AstBuilder<GitDiscardBranchNode>} Immutable rewind hook builder instance.
 */
export function createGitResetWorktreeBuilder(
  id = 'git-reset-worktree',
): AstBuilder<GitDiscardBranchNode> {
  return Object.freeze<AstBuilder<GitDiscardBranchNode>>({
    toAST(): GitDiscardBranchNode {
      return Object.freeze<GitDiscardBranchNode>({
        type: 'git:discard-branch',
        id,
        resetsRunOverlay: true,
      });
    },
  });
}
