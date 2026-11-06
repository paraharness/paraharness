import type { BaseToolASTNode } from '../base/base-tool-ast-node.js';
import type { NodeRunnerNode } from './node-runner-node.js';

/**
 * Passive AST node for the workspace-jailed file globbing tool (`fs:glob`).
 *
 * Enumerates workspace-relative file paths matching a POSIX glob pattern inside the active
 * isolation scope worktree.
 *
 * @template THandle Isolation scope handle type.
 */
export interface FsGlobToolNode<THandle = unknown>
  extends BaseToolASTNode<'fs:glob', 'declared', THandle> {
  /** Runner pool associated with the filesystem tool bundle. */
  readonly runner: NodeRunnerNode;
}
