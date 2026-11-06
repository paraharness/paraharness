import type { AstBuilder } from './ast-builder.js';
import type { MaybeBuilder } from './ast-foundation.types.js';
import type { ASTNode } from './ast-node.js';

/**
 * Normalizes a `MaybeBuilder<TNode>` value into its compiled passive `TNode` AST representation.
 *
 * Invokes `input.toAST()` when `input` is a fluent `AstBuilder<TNode>`, or returns `input` directly
 * when it is already a compiled `TNode`.
 *
 * @template TNode Passive AST node type extending `ASTNode`.
 *
 * @param {MaybeBuilder<TNode>} input - Passive AST node or fluent builder wrapping `TNode`.
 *
 * @returns {TNode} Compiled passive AST node.
 */
export function extractAST<TNode extends ASTNode>(input: MaybeBuilder<TNode>): TNode {
  if (
    typeof input === 'object' &&
    input !== null &&
    'toAST' in input &&
    typeof input.toAST === 'function'
  ) {
    return (input as AstBuilder<TNode>).toAST();
  }
  return input as TNode;
}
