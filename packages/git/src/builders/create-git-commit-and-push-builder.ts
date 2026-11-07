import {
  extractAST,
  z,
  type EnvRef,
  type GitCommitAndPushNode,
  type MaybeBuilder,
  type NodeRunnerNode,
} from '@harness-dsl/core';
import type { GitCommitAndPushBuilder } from './git-commit-and-push-builder.js';
import type { GitCommitAndPushOptions } from './git-commit-and-push-options.js';

/**
 * Creates a fluent `GitCommitAndPushBuilder` (`git.commitAndPush(id, options)`).
 *
 * Compiles into a passive `GitCommitAndPushNode<TIn>` with zero import-time or declaration-time I/O.
 *
 * @template TIn Step input payload type.
 *
 * @param {string}                       id      - Unique step node identifier.
 * @param {GitCommitAndPushOptions<TIn>} options - Branch projection, commit message projection, and optional bindings.
 *
 * @returns {GitCommitAndPushBuilder<TIn>} Immutable fluent `GitCommitAndPushBuilder` instance.
 *
 * @throws {Error} If `id` is empty.
 */
export function createGitCommitAndPushBuilder<TIn = unknown>(
  id: string,
  options: GitCommitAndPushOptions<TIn>,
): GitCommitAndPushBuilder<TIn> {
  if (id.trim().length === 0) {
    throw new Error("git.commitAndPush: 'id' must be a non-empty string.");
  }
  return Object.freeze<GitCommitAndPushBuilder<TIn>>({
    input<TNextIn>(
      schema: z.ZodType<TNextIn>,
    ): GitCommitAndPushBuilder<TNextIn> {
      return createGitCommitAndPushBuilder<TNextIn>(id, {
        branch: (nextIn: TNextIn): string => options.branch(nextIn as never),
        message: (nextIn: TNextIn): string => options.message(nextIn as never),
        inputSchema: schema,
        runner: options.runner,
        env: options.env,
      });
    },
    runner(runnerNode: MaybeBuilder<NodeRunnerNode>): GitCommitAndPushBuilder<TIn> {
      return createGitCommitAndPushBuilder<TIn>(id, {
        ...options,
        runner: runnerNode,
      });
    },
    env(envMap: Readonly<Record<string, string | EnvRef>>): GitCommitAndPushBuilder<TIn> {
      return createGitCommitAndPushBuilder<TIn>(id, {
        ...options,
        env: Object.freeze({ ...envMap }),
      });
    },
    toAST(): GitCommitAndPushNode<TIn> {
      const resolvedRunner: NodeRunnerNode =
        options.runner !== undefined
          ? extractAST(options.runner)
          : Object.freeze<NodeRunnerNode>({
              type: 'node:runner',
              id: 'git-default-runner',
              slots: 4,
              maxDaemons: 2,
            });
      const inputSchema: z.ZodType<TIn> =
        options.inputSchema ?? z.custom<TIn>(() => true);
      return Object.freeze<GitCommitAndPushNode<TIn>>({
        type: 'git:commit-and-push',
        id,
        inputSchema,
        outputSchema: z.void(),
        branch: options.branch,
        message: options.message,
        runner: resolvedRunner,
        env: options.env,
      });
    },
  });
}
