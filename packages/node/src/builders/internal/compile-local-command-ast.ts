import {
  extractAST,
  z,
  type AstBuilder,
  type LocalCommandCheckNode,
  type LocalCommandNode,
  type LocalCommandToolNode,
  type MaybeBuilder,
} from '@harness-dsl/core';
import type { LocalCommandBuilderState } from './local-command-builder-state.js';

/**
 * Normalizes a typed pre-check command builder or node into `LocalCommandNode<unknown, boolean, THandle>`.
 *
 * Wraps the input schema and argument/stdin mappers so `LocalCommandUnrepeatableConfig` can store
 * the pre-check command without unsound type assertions.
 *
 * @template TPreIn  Pre-check command input payload type.
 * @template THandle Isolation scope handle type.
 *
 * @param {MaybeBuilder<LocalCommandNode<TPreIn, boolean, THandle>>} preCheckCmd - Pre-check command node or builder.
 *
 * @returns {LocalCommandNode<unknown, boolean, THandle>} Normalized passive pre-check command node.
 */
export function normalizeUnrepeatablePreCheckNode<TPreIn, THandle>(
  preCheckCmd: MaybeBuilder<LocalCommandNode<TPreIn, boolean, THandle>>,
): LocalCommandNode<unknown, boolean, THandle> {
  const rawNode = extractAST(preCheckCmd);
  const rawArgv = rawNode.argv;
  const rawStdin = rawNode.stdinMode;
  return Object.freeze<LocalCommandNode<unknown, boolean, THandle>>({
    type: 'node:command',
    id: rawNode.id,
    inputSchema: z.unknown(),
    outputSchema: rawNode.outputSchema,
    runner: rawNode.runner,
    argv:
      typeof rawArgv === 'function'
        ? (input: unknown): readonly string[] => rawArgv(rawNode.inputSchema.parse(input))
        : rawArgv,
    stdinMode:
      rawStdin === 'closed'
        ? 'closed'
        : (input: unknown): string | Uint8Array => rawStdin(rawNode.inputSchema.parse(input)),
    env: rawNode.env,
    timeoutMinutes: rawNode.timeoutMinutes,
    unrepeatable: undefined,
  });
}

/**
 * Compiles `LocalCommandBuilderState` into a deeply frozen `LocalCommandNode`.
 *
 * Validates that `.argv(...)` has been configured and freezes all nested structures.
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

/**
 * Projects a compiled `LocalCommandNode` into a `LocalCommandCheckNode` builder and AST descriptor.
 *
 * Wraps the command inside a frozen `LocalCommandCheckNode` (`type: 'node:command-check'`).
 *
 * @template TIn     Validated command input payload type.
 * @template TOut    Validated command output payload type.
 * @template THandle Isolation scope handle type.
 *
 * @param {LocalCommandNode<TIn, TOut, THandle>} commandNode - Compiled command AST node.
 *
 * @returns {AstBuilder<LocalCommandCheckNode<THandle>> & LocalCommandCheckNode<THandle>} Frozen check builder and descriptor.
 */
export function compileLocalCommandCheckBuilder<TIn, TOut, THandle>(
  commandNode: LocalCommandNode<TIn, TOut, THandle>,
): AstBuilder<LocalCommandCheckNode<THandle>> & LocalCommandCheckNode<THandle> {
  const checkNode = Object.freeze<LocalCommandCheckNode<THandle>>({
    type: 'node:command-check',
    id: commandNode.id,
    command: commandNode,
  });
  return Object.freeze({
    type: 'node:command-check' as const,
    id: commandNode.id,
    command: commandNode,
    toAST(): LocalCommandCheckNode<THandle> {
      return checkNode;
    },
  });
}

/**
 * Projects a `LocalCommandBuilderState` into a post-flight-diffed `LocalCommandToolNode` builder and AST descriptor.
 *
 * Defaults `inputSchema` to `z.object({})` when `argv` is a static array and `.input()` was omitted,
 * and sets `effectTracking: 'subprocess-post-flight'`.
 *
 * @template TIn     Validated command input payload type.
 * @template TOut    Validated command output payload type.
 * @template THandle Isolation scope handle type.
 *
 * @param {LocalCommandBuilderState<TIn, TOut, THandle>} state - Current immutable builder state.
 *
 * @returns {AstBuilder<LocalCommandToolNode<THandle>> & LocalCommandToolNode<THandle>} Frozen tool builder and descriptor.
 */
export function compileLocalCommandToolBuilder<TIn, TOut, THandle>(
  state: LocalCommandBuilderState<TIn, TOut, THandle>,
): AstBuilder<LocalCommandToolNode<THandle>> & LocalCommandToolNode<THandle> {
  const commandNode = compileLocalCommandNode(state);
  const toolInputSchema: z.ZodTypeAny =
    typeof commandNode.argv === 'function' || state.hasExplicitInputSchema
      ? commandNode.inputSchema
      : z.object({});
  const description = `Execute local command ${commandNode.id}`;
  const toolNode = Object.freeze<LocalCommandToolNode<THandle>>({
    type: 'node:command-tool',
    name: commandNode.id,
    description,
    inputSchema: toolInputSchema,
    effectTracking: 'subprocess-post-flight',
    command: commandNode,
  });
  return Object.freeze({
    type: 'node:command-tool' as const,
    name: commandNode.id,
    description,
    inputSchema: toolInputSchema,
    effectTracking: 'subprocess-post-flight' as const,
    command: commandNode,
    toAST(): LocalCommandToolNode<THandle> {
      return toolNode;
    },
  });
}
