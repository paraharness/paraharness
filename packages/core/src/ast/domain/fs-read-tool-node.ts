import type { BaseToolASTNode } from '../base/base-tool-ast-node.js';
import type { NodeRunnerNode } from './node-runner-node.js';

/**
 * Passive AST node for the workspace-jailed file reading tool (`fs:read`).
 *
 * Reads UTF-8 file contents within the active isolation scope worktree and emits a declared
 * `FsToolEffect` read record for policy guard and read-before-write tracking.
 *
 * @template THandle Isolation scope handle type.
 */
export interface FsReadToolNode<THandle = unknown>
  extends BaseToolASTNode<'fs:read', 'declared', THandle> {
  /** Runner pool associated with the filesystem tool bundle. */
  readonly runner: NodeRunnerNode;
}
