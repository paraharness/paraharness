import {
  extractAST,
  z,
  type GitMergeQueueNode,
} from '@harness-dsl/core';
import type { GitMergeQueueBuilder } from './git-merge-queue-builder.js';
import type { GitMergeQueueOptions } from './git-merge-queue-options.js';

/**
 * Creates a fluent `GitMergeQueueBuilder` (`git.mergeQueue(id, options)`).
 *
 * Compiles into a passive `GitMergeQueueNode<TIn, TOut>` configuring cumulative merge-train batching and binary bisection.
 *
 * @template TIn  Validated step input type.
 * @template TOut Validated step output type.
 *
 * @param {string}                          id      - Unique merge queue step identifier.
 * @param {GitMergeQueueOptions<TIn, TOut>} options - Target branch, batch size, and verification check configuration.
 *
 * @returns {GitMergeQueueBuilder<TIn, TOut>} Immutable fluent `GitMergeQueueBuilder` instance.
 *
 * @throws {Error} If `id` is empty or `maxBatchSize` is not a positive integer.
 */
export function createGitMergeQueueBuilder<TIn = unknown, TOut = unknown>(
  id: string,
  options: GitMergeQueueOptions<TIn, TOut>,
): GitMergeQueueBuilder<TIn, TOut> {
  if (id.trim().length === 0) {
    throw new Error("git.mergeQueue: 'id' must be a non-empty string.");
  }
  const maxBatchSize = options.maxBatchSize ?? 4;
  if (!Number.isInteger(maxBatchSize) || maxBatchSize < 1) {
    throw new Error(`git.mergeQueue: 'maxBatchSize' must be a positive integer (received ${maxBatchSize}).`);
  }
  return Object.freeze<GitMergeQueueBuilder<TIn, TOut>>({
    input<TNextIn>(
      schema: z.ZodType<TNextIn, z.ZodTypeDef, unknown>,
    ): GitMergeQueueBuilder<TNextIn, TOut> {
      return createGitMergeQueueBuilder<TNextIn, TOut>(id, {
        targetBranch: options.targetBranch,
        maxBatchSize: options.maxBatchSize,
        verifyWith: options.verifyWith,
        inputSchema: schema,
        outputSchema: options.outputSchema,
      });
    },
    output<TNextOut>(
      schema: z.ZodType<TNextOut, z.ZodTypeDef, unknown>,
    ): GitMergeQueueBuilder<TIn, TNextOut> {
      return createGitMergeQueueBuilder<TIn, TNextOut>(id, {
        targetBranch: options.targetBranch,
        maxBatchSize: options.maxBatchSize,
        verifyWith: options.verifyWith,
        inputSchema: options.inputSchema,
        outputSchema: schema,
      });
    },
    toAST(): GitMergeQueueNode<TIn, TOut> {
      const inputSchema: z.ZodType<TIn, z.ZodTypeDef, unknown> =
        options.inputSchema ?? z.custom<TIn>(() => true);
      const outputSchema: z.ZodType<TOut, z.ZodTypeDef, unknown> =
        options.outputSchema ?? z.custom<TOut>(() => true);
      return Object.freeze<GitMergeQueueNode<TIn, TOut>>({
        type: 'git:merge-queue',
        id,
        inputSchema,
        outputSchema,
        targetBranch: options.targetBranch ?? 'main',
        maxBatchSize,
        verifyWith: extractAST(options.verifyWith),
      });
    },
  });
}
