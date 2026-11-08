import {
  extractAST,
  type GitRefReaderToolNode,
  type GitWorktreeHandle,
  type MaybeBuilder,
  type NodeRunnerNode,
} from '@metaharness/core';
import {
  DiffRefsInputSchema,
  ListRefFilesInputSchema,
  ReadRefFileInputSchema,
} from '../schemas/git-receipts.schema.js';

/**
 * Creates the read-only git object store inspection tool bundle (`git.refReaderTools(runner)`).
 *
 * Emits passive `GitRefReaderToolNode` descriptors for `readRefFile`, `diffRefs`, and `listRefFiles`
 * with `effectTracking: 'declared'` so actors can inspect `refs/harness/aborted/<run-id>/<stepExecId>`.
 *
 * @param {MaybeBuilder<NodeRunnerNode>} runner - Subprocess runner pool governing git command slots.
 *
 * @returns {readonly GitRefReaderToolNode<GitWorktreeHandle>[]} Frozen tuple of `readRefFile`, `diffRefs`, and `listRefFiles` tool AST nodes.
 */
export function createGitRefReaderTools(
  runner: MaybeBuilder<NodeRunnerNode>,
): readonly GitRefReaderToolNode<GitWorktreeHandle>[] {
  const runnerNode = extractAST(runner);
  const readRefFileNode = Object.freeze<GitRefReaderToolNode<GitWorktreeHandle>>({
    type: 'git:ref-reader-tool',
    name: 'readRefFile',
    description: 'Reads the contents of a repository-relative file at a specified git ref or commit SHA.',
    inputSchema: ReadRefFileInputSchema,
    effectTracking: 'declared',
    runner: runnerNode,
  });
  const diffRefsNode = Object.freeze<GitRefReaderToolNode<GitWorktreeHandle>>({
    type: 'git:ref-reader-tool',
    name: 'diffRefs',
    description: 'Computes the unified git diff between two git refs or commit SHAs.',
    inputSchema: DiffRefsInputSchema,
    effectTracking: 'declared',
    runner: runnerNode,
  });
  const listRefFilesNode = Object.freeze<GitRefReaderToolNode<GitWorktreeHandle>>({
    type: 'git:ref-reader-tool',
    name: 'listRefFiles',
    description: 'Lists tracked file paths inside the tree of a specified git ref or commit SHA.',
    inputSchema: ListRefFilesInputSchema,
    effectTracking: 'declared',
    runner: runnerNode,
  });
  return Object.freeze([readRefFileNode, diffRefsNode, listRefFilesNode]);
}
