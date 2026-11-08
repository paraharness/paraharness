import type {
  AstBuilder,
  LocalCommandCheckNode,
  LocalCommandNode,
} from '@metaharness/core';

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
  return Object.freeze<AstBuilder<LocalCommandCheckNode<THandle>> & LocalCommandCheckNode<THandle>>({
    type: 'node:command-check',
    id: commandNode.id,
    command: commandNode,
    toAST(): LocalCommandCheckNode<THandle> {
      return checkNode;
    },
  });
}
