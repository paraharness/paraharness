import {
  extractAST,
  type FsEditToolNode,
  type FsGlobToolNode,
  type FsGrepToolNode,
  type FsReadToolNode,
  type FsWriteToolNode,
  type MaybeBuilder,
  type NodeRunnerNode,
} from '@harness-dsl/core';
import {
  buildFsEditToolNode,
  buildFsGlobToolNode,
  buildFsGrepToolNode,
  buildFsReadToolNode,
  buildFsWriteToolNode,
} from './internal/build-fs-tool-nodes.js';

/**
 * Compiles the 5-tool workspace-jailed coding bundle (`fs.codingTools(runner)`).
 *
 * Returns passive `ToolASTNode` descriptors (`read_file`, `edit_file`, `write_file`,
 * `glob_files`, `grep_files`) with `effectTracking: 'declared'`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {MaybeBuilder<NodeRunnerNode>} runner - Runner pool AST node or builder.
 *
 * @returns {readonly [FsReadToolNode<THandle>, FsEditToolNode<THandle>, FsWriteToolNode<THandle>, FsGlobToolNode<THandle>, FsGrepToolNode<THandle>]} Frozen 5-tuple of filesystem coding tool AST nodes.
 */
export function createFsCodingTools<THandle = unknown>(
  runner: MaybeBuilder<NodeRunnerNode>,
): readonly [
  FsReadToolNode<THandle>,
  FsEditToolNode<THandle>,
  FsWriteToolNode<THandle>,
  FsGlobToolNode<THandle>,
  FsGrepToolNode<THandle>,
] {
  const runnerNode = extractAST(runner);
  return Object.freeze([
    buildFsReadToolNode<THandle>(runnerNode),
    buildFsEditToolNode<THandle>(runnerNode),
    buildFsWriteToolNode<THandle>(runnerNode),
    buildFsGlobToolNode<THandle>(runnerNode),
    buildFsGrepToolNode<THandle>(runnerNode),
  ]);
}
