import type { BaseToolASTNode } from '../base/base-tool-ast-node.js';
import type { NodeRunnerNode } from './node-runner-node.js';

/**
 * Passive AST node for the workspace-jailed file writing tool (`fs:write`).
 *
 * Creates or overwrites a UTF-8 file inside the active isolation scope and emits a declared
 * `FsToolEffect` write record.
 *
 * @template THandle Isolation scope handle type.
 */
export interface FsWriteToolNode<THandle = unknown>
  extends BaseToolASTNode<'fs:write', 'declared', THandle> {
  /** Runner pool associated with the filesystem tool bundle. */
  readonly runner: NodeRunnerNode;
}
