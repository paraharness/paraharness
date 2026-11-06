import type { ASTNode } from '../ast/ast-node.js';
import type { ExecutionContext } from './execution-context.js';

/**
 * Universal stateless executor function signature for passive discriminated-union AST nodes.
 *
 * Accepts the passive AST node, typed input payload, and runtime execution context, returning
 * either a synchronous or asynchronous output value.
 *
 * @template TNode    Passive AST node type discriminated by `readonly type: string`.
 * @template TInput   Input payload type consumed by the executor.
 * @template TOutput  Output payload type produced by the executor.
 * @template TContext Runtime execution context type supplied to the executor.
 */
export type NodeExecutor<
  TNode extends { readonly type: string } = ASTNode,
  TInput = unknown,
  TOutput = unknown,
  TContext = ExecutionContext,
> = (node: TNode, input: TInput, ctx: TContext) => TOutput | Promise<TOutput>;

/**
 * Mapped lookup table indexing `NodeExecutor` functions by each AST node member's `type` discriminant.
 *
 * Enables $O(1)$ runtime dispatch (`registry[category][node.type]`) with strict per-node type safety.
 *
 * @template TUnion   Discriminated union of AST node types belonging to the category.
 * @template TInput   Input payload type consumed by executors in this category.
 * @template TOutput  Output payload type produced by executors in this category.
 * @template TContext Runtime execution context type supplied to executors in this category.
 */
export type NodeExecutorMap<
  TUnion extends { readonly type: string },
  TInput = unknown,
  TOutput = unknown,
  TContext = ExecutionContext,
> = {
  readonly [TNode in TUnion as TNode['type']]?: NodeExecutor<TNode, TInput, TOutput, TContext>;
};
