import {
  z,
  type AstBuilder,
  type LocalCommandToolNode,
} from '@metaharness/core';
import { compileLocalCommandNode } from './compile-local-command-node.js';
import type { LocalCommandBuilderState } from './local-command-builder-state.js';

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
 *
 * @throws {Error} If `.argv(...)` was not configured on the command builder.
 */
export function compileLocalCommandToolBuilder<TIn, TOut, THandle>(
  state: LocalCommandBuilderState<TIn, TOut, THandle>,
): AstBuilder<LocalCommandToolNode<THandle>> & LocalCommandToolNode<THandle> {
  const commandNode = compileLocalCommandNode(state);
  const usesCommandSchema = typeof commandNode.argv === 'function' || state.hasExplicitInputSchema;
  const toolInputSchema: z.ZodTypeAny = usesCommandSchema ? commandNode.inputSchema : z.object({});
  const description = `Execute local command ${commandNode.id}`;
  const toolNode = Object.freeze<LocalCommandToolNode<THandle>>({
    type: 'node:command-tool',
    name: commandNode.id,
    description,
    inputSchema: toolInputSchema,
    effectTracking: 'subprocess-post-flight',
    command: commandNode,
  });
  return Object.freeze<AstBuilder<LocalCommandToolNode<THandle>> & LocalCommandToolNode<THandle>>({
    type: 'node:command-tool',
    name: commandNode.id,
    description,
    inputSchema: toolInputSchema,
    effectTracking: 'subprocess-post-flight',
    command: commandNode,
    toAST(): LocalCommandToolNode<THandle> {
      return toolNode;
    },
  });
}
