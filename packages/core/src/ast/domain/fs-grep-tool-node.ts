import type { BaseToolASTNode } from '../base/base-tool-ast-node.js';
import type { NodeRunnerNode } from './node-runner-node.js';

/**
 * Passive AST node for the workspace-jailed content search tool (`fs:grep`).
 *
 * Searches workspace files inside the active isolation scope against regular expression
 * patterns and returns matching lines with file and line numbers.
 *
 * @template THandle Isolation scope handle type.
 */
export interface FsGrepToolNode<THandle = unknown>
  extends BaseToolASTNode<'fs:grep', 'declared', THandle> {
  /** Runner pool associated with the filesystem tool bundle. */
  readonly runner: NodeRunnerNode;
}
