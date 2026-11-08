import type { AstBuilder, GitSnapshotAndResetNode } from '@metaharness/core';
import { GitAbortMetaSchema } from '../schemas/git-receipts.schema.js';

/**
 * Creates a fluent `AstBuilder<GitSnapshotAndResetNode>` (`git.snapshotAndReset()`).
 *
 * Compiles into a passive `GitSnapshotAndResetNode` (`type: 'git:snapshot-and-reset'`) that snapshots
 * an aborted worktree to `refs/harness/aborted/<run-id>/<stepExecId>` and resets to `handle.baseRef`.
 *
 * @param {string} [id='git-snapshot-and-reset'] - Optional custom identifier for the abort hook node.
 *
 * @returns {AstBuilder<GitSnapshotAndResetNode>} Immutable abort hook builder instance.
 */
export function createGitSnapshotAndResetBuilder(
  id = 'git-snapshot-and-reset',
): AstBuilder<GitSnapshotAndResetNode> {
  return Object.freeze<AstBuilder<GitSnapshotAndResetNode>>({
    toAST(): GitSnapshotAndResetNode {
      return Object.freeze<GitSnapshotAndResetNode>({
        type: 'git:snapshot-and-reset',
        id,
        metaSchema: GitAbortMetaSchema,
      });
    },
  });
}
