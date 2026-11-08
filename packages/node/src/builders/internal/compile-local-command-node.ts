import type { LocalCommandNode } from '@metaharness/core';
import type { LocalCommandBuilderState } from './local-command-builder-state.js';

/**
 * Compiles `LocalCommandBuilderState` into a deeply frozen `LocalCommandNode`.
 *
 * Validates that `.argv(...)` has been configured and freezes all nested structures in fixed property order.
 *
 * @template TIn     Validated command input payload type.
 * @template TOut    Validated command output payload type.
 * @template THandle Isolation scope handle type.
 *
 * @param {LocalCommandBuilderState<TIn, TOut, THandle>} state - Current immutable builder state.
 *
 * @returns {LocalCommandNode<TIn, TOut, THandle>} Frozen passive command AST node.
 *
 * @throws {Error} If `.argv(...)` was not configured on the builder.
 */
export function compileLocalCommandNode<TIn, TOut, THandle>(
  state: LocalCommandBuilderState<TIn, TOut, THandle>,
): LocalCommandNode<TIn, TOut, THandle> {
  if (state.argv === undefined) {
    throw new Error(`local.command('${state.id}') requires .argv(...) before compilation.`);
  }
  const frozenArgv =
    typeof state.argv === 'function' ? state.argv : Object.freeze([...state.argv]);
  const frozenEnv = state.env !== undefined ? Object.freeze({ ...state.env }) : undefined;
  return Object.freeze<LocalCommandNode<TIn, TOut, THandle>>({
    type: 'node:command',
    id: state.id,
    inputSchema: state.inputSchema,
    outputSchema: state.outputSchema,
    runner: state.runner,
    argv: frozenArgv,
    stdinMode: state.stdinMode,
    env: frozenEnv,
    timeoutMinutes: state.timeoutMinutes,
    unrepeatable: state.unrepeatable,
  });
}
