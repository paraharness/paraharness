import type {
  AstBuilder,
  ClaudeAccountSeatNode,
  ClaudeModelNode,
  MaybeBuilder,
  PoolNode,
} from '@harness-dsl/core';

/**
 * Fluent builder for constructing a passive `ClaudeModelNode` (`type: 'claude:model'`).
 *
 * Binds an Anthropic model identifier, optional reasoning effort budget, and an optional
 * `H.pool` of `ClaudeAccountSeatNode` seats with run-sticky KV-cache affinity.
 */
export interface ClaudeModelBuilder extends AstBuilder<ClaudeModelNode> {
  /** Logical alias of the model within the harness definition. */
  readonly alias: string;
  /** Provider-specific Anthropic model identifier transmitted on the wire. */
  readonly modelId: string;

  /**
   * Configures the reasoning effort level for extended thinking turns on this Claude model.
   *
   * Returns a new immutable `ClaudeModelBuilder` with the updated effort level.
   *
   * @param {'low' | 'medium' | 'high'} level - Extended thinking effort level.
   *
   * @returns {ClaudeModelBuilder} New immutable model builder with `effort` configured.
   */
  effort(level: 'low' | 'medium' | 'high'): ClaudeModelBuilder;

  /**
   * Attaches a capacity pool of `ClaudeAccountSeatNode` seats to multiplex requests with run-sticky affinity.
   *
   * Accepts either a compiled `PoolNode<ClaudeAccountSeatNode>` or a `PoolBuilder` instance.
   *
   * @param {MaybeBuilder<PoolNode<ClaudeAccountSeatNode>>} pool - Account seat pool node or builder.
   *
   * @returns {ClaudeModelBuilder} New immutable model builder bound to the specified account seat pool.
   */
  accountPool(pool: MaybeBuilder<PoolNode<ClaudeAccountSeatNode>>): ClaudeModelBuilder;

  /**
   * Alias for `accountPool(pool)` attaching a capacity pool of `ClaudeAccountSeatNode` seats.
   *
   * Preserves API symmetry across `@harness-dsl/claude`, `@harness-dsl/openai`, and `@harness-dsl/gemini`.
   *
   * @param {MaybeBuilder<PoolNode<ClaudeAccountSeatNode>>} pool - Account seat pool node or builder.
   *
   * @returns {ClaudeModelBuilder} New immutable model builder bound to the specified account seat pool.
   */
  pool(pool: MaybeBuilder<PoolNode<ClaudeAccountSeatNode>>): ClaudeModelBuilder;

  /**
   * Compiles the builder configuration into a deeply frozen passive `ClaudeModelNode` AST node.
   *
   * Produces a monomorphic AST node with `type: 'claude:model'` and `vendor: 'anthropic'`.
   *
   * @returns {ClaudeModelNode} Frozen passive AST node representing the Claude model.
   */
  toAST(): ClaudeModelNode;
}
