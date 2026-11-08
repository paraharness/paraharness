import type {
  BaseCheckASTNode,
  GitWorktreeHandle,
  MaybeBuilder,
  z,
} from '@metaharness/core';

/**
 * Configuration options for `git.mergeQueue(id, options)` (`createGitMergeQueueBuilder`).
 *
 * Specifies the upstream `targetBranch`, `maxBatchSize` for speculative cumulative merge trains,
 * and the `verifyWith` check executed against the cumulative tip commit $R_k$.
 *
 * @template TIn  Validated step input type.
 * @template TOut Validated step output type.
 */
export interface GitMergeQueueOptions<TIn = unknown, TOut = unknown> {
  /** Target upstream branch into which approved runs are merged (defaults to `'main'`). */
  readonly targetBranch?: string;
  /** Maximum number of runs combined into a single speculative verification batch (defaults to `4`). */
  readonly maxBatchSize?: number;
  /** Deterministic verification check executed against the cumulative merge head. */
  readonly verifyWith: MaybeBuilder<BaseCheckASTNode<string, GitWorktreeHandle>>;
  /** Optional Zod schema validating the merge queue step input payload. */
  readonly inputSchema?: z.ZodType<TIn>;
  /** Optional Zod schema validating the merge queue step output payload. */
  readonly outputSchema?: z.ZodType<TOut>;
}
