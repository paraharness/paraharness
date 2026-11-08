import type { AstBuilder, GitDiscardBranchNode } from '@paraharness/core';

/**
 * Creates a fluent `AstBuilder<GitDiscardBranchNode>` (`git.discardBranch()`).
 *
 * Alias for `createGitResetWorktreeBuilder` compiling to a passive `GitDiscardBranchNode`
 * (`type: 'git:discard-branch'`, `resetsRunOverlay: true`).
 *
 * @param {string} [id='git-discard-branch'] - Optional custom identifier for the rewind hook node.
 *
 * @returns {AstBuilder<GitDiscardBranchNode>} Immutable rewind hook builder instance.
 */
export function createGitDiscardBranchBuilder(
  id = 'git-discard-branch',
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
