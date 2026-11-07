import type { AstBuilder, GitKeepWorktreeNode } from '@harness-dsl/core';

/**
 * Creates a fluent `AstBuilder<GitKeepWorktreeNode>` (`git.keepWorktree()`).
 *
 * Compiles into a passive `GitKeepWorktreeNode` (`type: 'git:keep-worktree'`, `resetsRunOverlay: false`)
 * that preserves the active worktree and uncommitted topology overlay across a `.rewindTo()` signal.
 *
 * @param {string} [id='git-keep-worktree'] - Optional custom identifier for the rewind hook node.
 *
 * @returns {AstBuilder<GitKeepWorktreeNode>} Immutable rewind hook builder instance.
 */
export function createGitKeepWorktreeBuilder(
  id = 'git-keep-worktree',
): AstBuilder<GitKeepWorktreeNode> {
  return Object.freeze<AstBuilder<GitKeepWorktreeNode>>({
    toAST(): GitKeepWorktreeNode {
      return Object.freeze<GitKeepWorktreeNode>({
        type: 'git:keep-worktree',
        id,
        resetsRunOverlay: false,
      });
    },
  });
}
