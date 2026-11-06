import type { BaseToolASTNode } from '../base/base-tool-ast-node.js';

/**
 * Passive AST node representing a post-flight-diffed interaction tool bound to a `LocalServiceNode`.
 *
 * Dispatches framed PTY commands against the active daemon session identified by `serviceId`
 * and verifies post-flight workspace mutations via `CheckpointableScope.diffEffects()`.
 *
 * @template THandle Isolation scope handle type.
 */
export interface LocalServiceToolNode<THandle = unknown>
  extends BaseToolASTNode<'node:service-tool', 'subprocess-post-flight', THandle> {
  /** Identifier of the owning `LocalServiceNode` session. */
  readonly serviceId: string;
}
