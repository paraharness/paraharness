import type { AstBuilder } from './ast-builder.js';
import type { MaybeBuilder } from './ast-foundation.types.js';
import type { ASTNode } from './ast-node.js';

/**
 * Type guard testing whether a `MaybeBuilder<TNode>` value implements the `AstBuilder<TNode>` interface.
 *
 * Inspects whether `input` is a non-null object exposing a callable `toAST` method before narrowing
 * `MaybeBuilder<TNode>` to `AstBuilder<TNode>`.
 *
 * @template TNode Passive AST node type.
 *
 * @param {MaybeBuilder<TNode>} input - Candidate AST node or builder instance.
 *
 * @returns {input is AstBuilder<TNode>} True when `input` exposes a callable `.toAST()` method.
 */
function isAstBuilder<TNode extends ASTNode>(
  input: MaybeBuilder<TNode>,
): input is AstBuilder<TNode> {
  return typeof input === 'object' && input !== null && 'toAST' in input && typeof input.toAST === 'function';
}

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
  return isAstBuilder(input) ? input.toAST() : input;
}
