import type {
  BivariantCallback,
  EnvRef,
  MaybeBuilder,
  NodeRunnerNode,
  z,
} from '@paraharness/core';

/**
 * Configuration options for `git.commitAndPush(id, options)` (`createGitCommitAndPushBuilder`).
 *
 * Defines the target remote branch projection (`branch`), commit message projection (`message`),
 * and optional input schema, runner pool, and environment bindings.
 *
 * @template TIn Step input payload type.
 */
export interface GitCommitAndPushOptions<TIn = unknown> {
  /** Pure projection deriving the target remote branch name from `TIn`. */
  readonly branch: BivariantCallback<[input: TIn], string>;
  /** Pure projection deriving the commit message from `TIn`. */
  readonly message: BivariantCallback<[input: TIn], string>;
  /** Optional Zod schema validating the step input payload. */
  readonly inputSchema?: z.ZodType<TIn>;
  /** Optional runner pool governing subprocess slot concurrency. */
  readonly runner?: MaybeBuilder<NodeRunnerNode>;
  /** Optional environment variables or symbolic `EnvRef` bindings injected into git commands. */
  readonly env?: Readonly<Record<string, string | EnvRef>>;
}
