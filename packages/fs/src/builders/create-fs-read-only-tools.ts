import {
  DEFAULT_NODE_RUNNER_AST_NODE,
  extractAST,
  type FsGlobToolNode,
  type FsGrepToolNode,
  type FsReadToolNode,
  type MaybeBuilder,
  type NodeRunnerNode,
} from '@paraharness/core';
import {
  buildFsGlobToolNode,
  buildFsGrepToolNode,
  buildFsReadToolNode,
} from './internal/build-fs-tool-nodes.js';

/**
 * Compiles the 3-tool workspace-jailed read-only bundle (`fs.readOnlyTools(runner?)`).
 *
 * Returns passive `ToolASTNode` descriptors (`read_file`, `glob_files`, `grep_files`)
 * with `effectTracking: 'declared'` for evaluators, adjudicators, and arbiters, defaulting
 * `runner` to `DEFAULT_NODE_RUNNER_AST_NODE` when omitted.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {MaybeBuilder<NodeRunnerNode>} [runner=DEFAULT_NODE_RUNNER_AST_NODE] - Optional runner pool AST node or builder.
 *
 * @returns {readonly [FsReadToolNode<THandle>, FsGlobToolNode<THandle>, FsGrepToolNode<THandle>]} Frozen 3-tuple of read-only filesystem tool AST nodes.
 */
export function createFsReadOnlyTools<THandle = unknown>(
  runner: MaybeBuilder<NodeRunnerNode> = DEFAULT_NODE_RUNNER_AST_NODE,
): readonly [FsReadToolNode<THandle>, FsGlobToolNode<THandle>, FsGrepToolNode<THandle>] {
  const runnerNode = extractAST(runner);
  return Object.freeze([
    buildFsReadToolNode<THandle>(runnerNode),
    buildFsGlobToolNode<THandle>(runnerNode),
    buildFsGrepToolNode<THandle>(runnerNode),
  ]);
}
