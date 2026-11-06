import type { PoolNode } from '../pool-node.js';
import type { BaseAccountSeatASTNode } from './base-account-seat-ast-node.js';

/**
 * Domain-agnostic base AST node contract for LLM model configurations (`ModelASTNode`).
 *
 * Resolved via `RuntimeExecutorRegistry.models[node.type]` into a vendor `ModelDriver`.
 *
 * @template TType String-literal discriminant of the model node.
 * @template TSeat Account seat AST node type compatible with this model's `accountPool`.
 */
export interface BaseModelASTNode<
  TType extends string = string,
  TSeat extends BaseAccountSeatASTNode = BaseAccountSeatASTNode,
> {
  /** Unique string-literal discriminant of the model node. */
  readonly type: TType;
  /** Logical alias of the model within the harness definition. */
  readonly alias: string;
  /** Provider-specific model identifier transmitted on the wire. */
  readonly modelId: string;
  /** Optional reasoning effort level requested from the provider. */
  readonly effort?: 'low' | 'medium' | 'high';
  /** Optional pool of provider account seats backing this model. */
  readonly accountPool?: PoolNode<TSeat>;
}
