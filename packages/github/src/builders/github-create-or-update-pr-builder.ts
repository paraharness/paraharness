import type { AstBuilder, GithubCreateOrUpdatePrNode, z } from '@metaharness/core';

/**
 * Fluent builder for a `GithubCreateOrUpdatePrNode` domain step (`github.createOrUpdatePr`).
 *
 * Supports narrowing the step's input and output Zod validation schemas before compiling
 * into a deeply frozen passive `GithubCreateOrUpdatePrNode` via `.toAST()`.
 *
 * @template TIn     Validated step input payload type.
 * @template TOut    Validated step output payload type.
 * @template THandle Runtime handle type of the enclosing isolation scope.
 */
export interface GithubCreateOrUpdatePrBuilder<
  TIn = unknown,
  TOut = unknown,
  THandle = unknown,
> extends AstBuilder<GithubCreateOrUpdatePrNode<TIn, TOut, THandle>> {
  /** Unique step node identifier. */
  readonly id: string;

  /**
   * Binds a new Zod input schema for the pull-request creation step.
   *
   * Returns a new immutable builder instance typed for `TNextIn`.
   *
   * @template TNextIn New validated step input payload type.
   *
   * @param {z.ZodType<TNextIn>} schema - Zod schema validating step input.
   *
   * @returns {GithubCreateOrUpdatePrBuilder<TNextIn, TOut, THandle>} Updated immutable builder instance.
   */
  input<TNextIn>(
    schema: z.ZodType<TNextIn>,
  ): GithubCreateOrUpdatePrBuilder<TNextIn, TOut, THandle>;

  /**
   * Binds a new Zod output schema for the pull-request creation step.
   *
   * Returns a new immutable builder instance typed for `TNextOut`.
   *
   * @template TNextOut New validated step output payload type.
   *
   * @param {z.ZodType<TNextOut>} schema - Zod schema validating step output.
   *
   * @returns {GithubCreateOrUpdatePrBuilder<TIn, TNextOut, THandle>} Updated immutable builder instance.
   */
  output<TNextOut>(
    schema: z.ZodType<TNextOut>,
  ): GithubCreateOrUpdatePrBuilder<TIn, TNextOut, THandle>;

  /**
   * Compiles the builder configuration into a passive, frozen `GithubCreateOrUpdatePrNode`.
   *
   * Preserves all configured projections and boundary schemas on the resulting AST node.
   *
   * @returns {GithubCreateOrUpdatePrNode<TIn, TOut, THandle>} Compiled passive AST node.
   */
  toAST(): GithubCreateOrUpdatePrNode<TIn, TOut, THandle>;
}
