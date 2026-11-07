import type {
  AstBuilder,
  EnvRef,
  GitCommitAndPushNode,
  MaybeBuilder,
  NodeRunnerNode,
  z,
} from '@harness-dsl/core';

/**
 * Fluent builder for a retry-safe commit, rebase, and push domain step (`git.commitAndPush`).
 *
 * Compiles into a passive `GitCommitAndPushNode<TIn>` (`type: 'git:commit-and-push'`) dispatched
 * via `RuntimeExecutorRegistry.steps['git:commit-and-push']`.
 *
 * @template TIn Step input payload type.
 */
export interface GitCommitAndPushBuilder<TIn = unknown>
  extends AstBuilder<GitCommitAndPushNode<TIn>> {
  /**
   * Binds a Zod schema validating the step input payload passed to `branch(input)` and `message(input)`.
   *
   * Narrows or updates the builder's `TIn` type parameter to match the supplied `schema`.
   *
   * @template TNextIn Updated step input payload type inferred from `schema`.
   *
   * @param {z.ZodType<TNextIn, z.ZodTypeDef, unknown>} schema - Zod schema for step input validation.
   *
   * @returns {GitCommitAndPushBuilder<TNextIn>} Updated immutable step builder instance.
   */
  input<TNextIn>(
    schema: z.ZodType<TNextIn, z.ZodTypeDef, unknown>,
  ): GitCommitAndPushBuilder<TNextIn>;

  /**
   * Binds the `NodeRunnerNode` pool governing git and verification subprocess concurrency.
   *
   * Accepts either a compiled `NodeRunnerNode` or a fluent `AstBuilder<NodeRunnerNode>`.
   *
   * @param {MaybeBuilder<NodeRunnerNode>} runner - Runner pool descriptor or builder.
   *
   * @returns {GitCommitAndPushBuilder<TIn>} Updated immutable step builder instance.
   */
  runner(runner: MaybeBuilder<NodeRunnerNode>): GitCommitAndPushBuilder<TIn>;

  /**
   * Binds environment variables or symbolic `H.env(key)` references injected into git commands.
   *
   * Symbolic `EnvRef` values are preserved in the AST and resolved exclusively at runtime execution.
   *
   * @param {Readonly<Record<string, string | EnvRef>>} env - Environment map to attach to the step node.
   *
   * @returns {GitCommitAndPushBuilder<TIn>} Updated immutable step builder instance.
   */
  env(env: Readonly<Record<string, string | EnvRef>>): GitCommitAndPushBuilder<TIn>;
}
