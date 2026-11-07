import type { AstBuilder, GitMergeQueueNode, z } from '@harness-dsl/core';

/**
 * Fluent builder for cumulative batch merge-train verification (`git.mergeQueue`).
 *
 * Compiles into a passive `GitMergeQueueNode<TIn, TOut>` (`type: 'git:merge-queue'`) dispatched
 * via `RuntimeExecutorRegistry.steps['git:merge-queue']`.
 *
 * @template TIn  Validated step input type.
 * @template TOut Validated step output type.
 */
export interface GitMergeQueueBuilder<TIn = unknown, TOut = unknown>
  extends AstBuilder<GitMergeQueueNode<TIn, TOut>> {
  /**
   * Binds a Zod schema validating the step input payload.
   *
   * Narrows the builder's `TIn` type parameter to match the supplied `schema`.
   *
   * @template TNextIn Updated step input payload type inferred from `schema`.
   *
   * @param {z.ZodType<TNextIn, z.ZodTypeDef, unknown>} schema - Zod schema for step input validation.
   *
   * @returns {GitMergeQueueBuilder<TNextIn, TOut>} Updated immutable merge queue builder instance.
   */
  input<TNextIn>(
    schema: z.ZodType<TNextIn, z.ZodTypeDef, unknown>,
  ): GitMergeQueueBuilder<TNextIn, TOut>;

  /**
   * Binds a Zod schema validating the step output payload.
   *
   * Narrows the builder's `TOut` type parameter to match the supplied `schema`.
   *
   * @template TNextOut Updated step output payload type inferred from `schema`.
   *
   * @param {z.ZodType<TNextOut, z.ZodTypeDef, unknown>} schema - Zod schema for step output validation.
   *
   * @returns {GitMergeQueueBuilder<TIn, TNextOut>} Updated immutable merge queue builder instance.
   */
  output<TNextOut>(
    schema: z.ZodType<TNextOut, z.ZodTypeDef, unknown>,
  ): GitMergeQueueBuilder<TIn, TNextOut>;
}
