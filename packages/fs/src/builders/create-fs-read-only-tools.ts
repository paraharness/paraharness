import type {
  FsGlobToolNode,
  FsGrepToolNode,
  FsReadToolNode,
  MaybeBuilder,
  NodeRunnerNode,
} from '@harness-dsl/core';
import { createFsCodingTools } from './create-fs-coding-tools.js';

/**
 * Compiles the 3-tool workspace-jailed read-only bundle (`fs.readOnlyTools(runner)`).
 *
 * Returns passive `ToolASTNode` descriptors (`read_file`, `glob_files`, `grep_files`)
 * with `effectTracking: 'declared'` for evaluators, adjudicators, and arbiters.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {MaybeBuilder<NodeRunnerNode>} runner - Runner pool AST node or builder.
 *
 * @returns {readonly [FsReadToolNode<THandle>, FsGlobToolNode<THandle>, FsGrepToolNode<THandle>]} Frozen 3-tuple of read-only filesystem tool AST nodes.
 */
export function createFsReadOnlyTools<THandle = unknown>(
  runner: MaybeBuilder<NodeRunnerNode>,
): readonly [FsReadToolNode<THandle>, FsGlobToolNode<THandle>, FsGrepToolNode<THandle>] {
  const [readTool, , , globTool, grepTool] = createFsCodingTools<THandle>(runner);
  return Object.freeze([readTool, globTool, grepTool]);
}
