import type {
  AstBuilder,
  GeminiAccountSeatNode,
  GeminiModelNode,
  MaybeBuilder,
  PoolNode,
} from '@metaharness/core';

/**
 * Fluent builder for constructing a passive `GeminiModelNode` (`type: 'gemini:model'`).
 *
 * Binds a Google Gemini model identifier, optional thinking level (`effort`), and an optional
 * `M.pool` of `GeminiAccountSeatNode` seats with run-sticky seat affinity.
 */
export interface GeminiModelBuilder extends AstBuilder<GeminiModelNode> {
  /** Logical alias of the model within the harness definition. */
  readonly alias: string;
  /** Provider-specific Gemini model identifier transmitted on the wire. */
  readonly modelId: string;

  /**
   * Configures the thinking level (`'low' | 'medium' | 'high'`) for Gemini `generateContent` turns.
   *
   * Returns a new immutable `GeminiModelBuilder` with the updated effort level.
   *
   * @param {'low' | 'medium' | 'high'} level - Thinking effort level.
   *
   * @returns {GeminiModelBuilder} New immutable model builder with `effort` configured.
   */
  effort(level: 'low' | 'medium' | 'high'): GeminiModelBuilder;

  /**
   * Attaches a capacity pool of `GeminiAccountSeatNode` seats to multiplex requests with run-sticky affinity.
   *
   * Accepts either a compiled `PoolNode<GeminiAccountSeatNode>` or a `PoolBuilder` instance.
   *
   * @param {MaybeBuilder<PoolNode<GeminiAccountSeatNode>>} pool - Account seat pool node or builder.
   *
   * @returns {GeminiModelBuilder} New immutable model builder bound to the specified account seat pool.
   */
  pool(pool: MaybeBuilder<PoolNode<GeminiAccountSeatNode>>): GeminiModelBuilder;

  /**
   * Alias for `pool(pool)` attaching a capacity pool of `GeminiAccountSeatNode` seats.
   *
   * Preserves API symmetry across `@metaharness/claude`, `@metaharness/openai`, and `@metaharness/gemini`.
   *
   * @param {MaybeBuilder<PoolNode<GeminiAccountSeatNode>>} pool - Account seat pool node or builder.
   *
   * @returns {GeminiModelBuilder} New immutable model builder bound to the specified account seat pool.
   */
  accountPool(pool: MaybeBuilder<PoolNode<GeminiAccountSeatNode>>): GeminiModelBuilder;

  /**
   * Compiles the builder configuration into a deeply frozen passive `GeminiModelNode` AST node.
   *
   * Produces a monomorphic AST node with `type: 'gemini:model'` and `vendor: 'google'`.
   *
   * @returns {GeminiModelNode} Frozen passive AST node representing the Gemini model.
   */
  toAST(): GeminiModelNode;
}
