import type {
  AstBuilder,
  MaybeBuilder,
  OpenAiAccountSeatNode,
  OpenAiModelNode,
  PoolNode,
} from '@paraharness/core';

/**
 * Fluent builder for constructing a passive `OpenAiModelNode` (`type: 'openai:model'`).
 *
 * Binds an OpenAI model identifier, optional reasoning effort level, and an optional
 * `P.pool` of `OpenAiAccountSeatNode` seats with run-sticky seat affinity and cross-seat failover stripping.
 */
export interface OpenAiModelBuilder extends AstBuilder<OpenAiModelNode> {
  /** Logical alias of the model within the harness definition. */
  readonly alias: string;
  /** Provider-specific OpenAI model identifier transmitted on the wire. */
  readonly modelId: string;

  /**
   * Configures the reasoning effort level for OpenAI Responses API turns on this model.
   *
   * Returns a new immutable `OpenAiModelBuilder` with the updated effort level.
   *
   * @param {'low' | 'medium' | 'high'} level - Reasoning effort level.
   *
   * @returns {OpenAiModelBuilder} New immutable model builder with `effort` configured.
   */
  effort(level: 'low' | 'medium' | 'high'): OpenAiModelBuilder;

  /**
   * Attaches a capacity pool of `OpenAiAccountSeatNode` seats to multiplex requests with run-sticky affinity.
   *
   * Accepts either a compiled `PoolNode<OpenAiAccountSeatNode>` or a `PoolBuilder` instance.
   *
   * @param {MaybeBuilder<PoolNode<OpenAiAccountSeatNode>>} pool - Account seat pool node or builder.
   *
   * @returns {OpenAiModelBuilder} New immutable model builder bound to the specified account seat pool.
   */
  accountPool(pool: MaybeBuilder<PoolNode<OpenAiAccountSeatNode>>): OpenAiModelBuilder;

  /**
   * Alias for `accountPool(pool)` attaching a capacity pool of `OpenAiAccountSeatNode` seats.
   *
   * Preserves API symmetry across `@paraharness/claude`, `@paraharness/openai`, and `@paraharness/gemini`.
   *
   * @param {MaybeBuilder<PoolNode<OpenAiAccountSeatNode>>} pool - Account seat pool node or builder.
   *
   * @returns {OpenAiModelBuilder} New immutable model builder bound to the specified account seat pool.
   */
  pool(pool: MaybeBuilder<PoolNode<OpenAiAccountSeatNode>>): OpenAiModelBuilder;

  /**
   * Compiles the builder configuration into a deeply frozen passive `OpenAiModelNode` AST node.
   *
   * Produces a monomorphic AST node with `type: 'openai:model'` and `vendor: 'openai'`.
   *
   * @returns {OpenAiModelNode} Frozen passive AST node representing the OpenAI model.
   */
  toAST(): OpenAiModelNode;
}
