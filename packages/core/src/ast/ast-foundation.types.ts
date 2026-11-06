import type { AstBuilder } from './ast-builder.js';
import type { ASTNode } from './ast-node.js';
import type { ScopeCapabilityTier } from './base/base-domain-ast.types.js';
import type { SourceASTNode } from './domain-ast.types.js';

export type { ScopeCapabilityTier };

/**
 * Bivariant function type enabling covariance across generic AST node and port collections under `strictFunctionTypes: true` without `any`.
 *
 * @template TArgs   Ordered tuple of function parameter types.
 * @template TResult Function return type.
 */
export type BivariantCallback<TArgs extends readonly unknown[], TResult = unknown> = {
  bivarianceHack(...args: TArgs): TResult;
}['bivarianceHack'];

/**
 * Union accepting either a compiled passive `TNode` AST node or a fluent `AstBuilder<TNode>` instance.
 *
 * Normalized at builder composition boundaries via `extractAST(input)`.
 *
 * @template TNode Passive AST node type.
 */
export type MaybeBuilder<TNode extends ASTNode> = TNode | AstBuilder<TNode>;

/**
 * Value that is either an inline literal `T` or a passive `SourceASTNode<T>` resolved at runtime via `RuntimeExecutorRegistry.sources`.
 *
 * @template T Resolved content payload type.
 */
export type SourceValue<T> = T | SourceASTNode<T>;

/**
 * Input union accepting an inline value `T`, a compiled `SourceASTNode<T>`, or a fluent `AstBuilder<SourceASTNode<T>>`.
 *
 * @template T Resolved content payload type.
 */
export type MaybeSource<T> = SourceValue<T> | AstBuilder<SourceASTNode<T>>;
