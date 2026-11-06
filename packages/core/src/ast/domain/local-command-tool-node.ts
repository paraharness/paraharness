import type { BaseToolASTNode } from '../base/base-tool-ast-node.js';
import type { LocalCommandNode } from './local-command-node.js';

/**
 * Passive AST node adapting a `LocalCommandNode` into a post-flight-diffed `ToolASTNode` (`cmd.asTool()`).
 *
 * Sets `effectTracking: 'subprocess-post-flight'` so workspace mutations are always verified via
 * `CheckpointableScope.diffEffects()`.
 *
 * @template THandle Isolation scope handle type.
 */
export interface LocalCommandToolNode<THandle = unknown>
  extends BaseToolASTNode<'node:command-tool', 'subprocess-post-flight', THandle> {
  /** Underlying one-shot command node invoked by the tool. */
  readonly command: LocalCommandNode<unknown, unknown, THandle>;
}
