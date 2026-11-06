import type { BaseToolASTNode } from '../base/base-tool-ast-node.js';
import type { LocalStreamCheckNode } from './local-stream-check-node.js';

/**
 * Passive AST node adapting a `LocalStreamCheckNode` into a post-flight-diffed `ToolASTNode` (`streamCheck.asTool()`).
 *
 * Executes the streaming check inside a checkpoint-sandboxed tool turn and verifies post-flight
 * workspace mutations via `CheckpointableScope.diffEffects()`.
 *
 * @template THandle Isolation scope handle type.
 */
export interface LocalStreamCheckToolNode<THandle = unknown>
  extends BaseToolASTNode<'node:stream-check-tool', 'subprocess-post-flight', THandle> {
  /** Underlying streaming check node executed by the tool. */
  readonly check: LocalStreamCheckNode<THandle>;
}
