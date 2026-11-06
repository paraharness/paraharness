import type { BaseCheckASTNode } from '../base/base-check-ast-node.js';
import type { LocalCommandNode } from './local-command-node.js';

/**
 * Passive AST node adapting a `LocalCommandNode` into a deterministic `CheckASTNode` (`cmd.asCheck()`).
 *
 * Executes the underlying `command` inside the active isolation scope and reports a passing
 * check when the subprocess exits with status code `0`.
 *
 * @template THandle Isolation scope handle type.
 */
export interface LocalCommandCheckNode<THandle = unknown>
  extends BaseCheckASTNode<'node:command-check', THandle> {
  /** Underlying one-shot command node executed by the check. */
  readonly command: LocalCommandNode<unknown, unknown, THandle>;
}
