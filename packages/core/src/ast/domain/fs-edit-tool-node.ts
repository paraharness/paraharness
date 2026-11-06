import type { BaseToolASTNode } from '../base/base-tool-ast-node.js';
import type { NodeRunnerNode } from './node-runner-node.js';

/**
 * Passive AST node for the workspace-jailed file editing tool (`fs:edit`).
 *
 * Applies exact string replacements to an existing file inside the active isolation scope
 * and emits a declared `FsToolEffect` write record.
 *
 * @template THandle Isolation scope handle type.
 */
export interface FsEditToolNode<THandle = unknown>
  extends BaseToolASTNode<'fs:edit', 'declared', THandle> {
  /** Runner pool associated with the filesystem tool bundle. */
  readonly runner: NodeRunnerNode;
}
