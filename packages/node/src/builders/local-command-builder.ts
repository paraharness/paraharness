import type {
  AstBuilder,
  BivariantCallback,
  EnvRef,
  LocalCommandCheckNode,
  LocalCommandNode,
  LocalCommandToolNode,
  MaybeBuilder,
  NodeRunnerNode,
  z,
} from '@harness-dsl/core';

/**
 * Options for configuring an idempotency guard on `local.command().unrepeatable(preCheckCmd, options)`.
 *
 * Supplies a static deduplication key or a synchronous mapper extracting the deduplication key from the command input.
 *
 * @template TIn Validated command input payload type.
 */
export interface LocalCommandUnrepeatableOptions<TIn = unknown> {
  /** Static deduplication key or synchronous mapper deriving the key from `TIn`. */
  readonly key: string | BivariantCallback<[input: TIn], string>;
}

/**
 * Fluent builder for a one-shot local OS subprocess command (`local.command(id)`).
 *
 * Compiles to a passive `LocalCommandNode` participating in `StepASTNode` and provides
 * `.asCheck()` and `.asTool()` projections for deterministic gates and post-flight-diffed agent tools.
 *
 * @template TIn     Validated command input payload type.
 * @template TOut    Validated command output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface LocalCommandBuilder<TIn = unknown, TOut = unknown, THandle = unknown>
  extends AstBuilder<LocalCommandNode<TIn, TOut, THandle>> {
  /** Unique identifier of the local command. */
  readonly id: string;

  /**
   * Binds the `NodeRunnerNode` pool governing concurrency slots for this command.
   *
   * Acquires a one-shot slot via `RunnerDriver.withSlot` whenever the command executes.
   *
   * @param {MaybeBuilder<NodeRunnerNode>} runner - Runner pool AST node or builder.
   *
   * @returns {LocalCommandBuilder<TIn, TOut, THandle>} Updated immutable command builder.
   */
  runner(runner: MaybeBuilder<NodeRunnerNode>): LocalCommandBuilder<TIn, TOut, THandle>;

  /**
   * Configures standard input handling (`'closed'` or a synchronous payload mapper).
   *
   * Enforces closed stdin by default so interactive CLI prompts never hang runner slots.
   *
   * @param {'closed' | BivariantCallback<[input: TIn], string | Uint8Array>} mode - Standard input mode or mapper.
   *
   * @returns {LocalCommandBuilder<TIn, TOut, THandle>} Updated immutable command builder.
   */
  stdin(
    mode: 'closed' | BivariantCallback<[input: TIn], string | Uint8Array>,
  ): LocalCommandBuilder<TIn, TOut, THandle>;

  /**
   * Binds static string or symbolic `EnvRef` environment variables injected into the subprocess.
   *
   * Symbolic `EnvRef` entries are resolved via `ctx.resolveEnv` at leaf execution time.
   *
   * @param {Readonly<Record<string, string | EnvRef>>} envVars - Environment variable map.
   *
   * @returns {LocalCommandBuilder<TIn, TOut, THandle>} Updated immutable command builder.
   */
  env(
    envVars: Readonly<Record<string, string | EnvRef>>,
  ): LocalCommandBuilder<TIn, TOut, THandle>;

  /**
   * Binds the static argument vector or synchronous input-to-`argv` mapper function.
   *
   * Index `0` of the returned array specifies the executable binary and subsequent entries are arguments.
   *
   * @param {readonly string[] | BivariantCallback<[input: TIn], readonly string[]>} args - Argument vector or mapper.
   *
   * @returns {LocalCommandBuilder<TIn, TOut, THandle>} Updated immutable command builder.
   */
  argv(
    args: readonly string[] | BivariantCallback<[input: TIn], readonly string[]>,
  ): LocalCommandBuilder<TIn, TOut, THandle>;

  /**
   * Sets the execution timeout in minutes before the subprocess group is terminated.
   *
   * Sends `SIGTERM` followed by `SIGKILL` to the detached process group when the timeout expires.
   *
   * @param {number} minutes - Positive timeout duration in minutes.
   *
   * @returns {LocalCommandBuilder<TIn, TOut, THandle>} Updated immutable command builder.
   */
  timeoutMinutes(minutes: number): LocalCommandBuilder<TIn, TOut, THandle>;

  /**
   * Binds the Zod validation schema for the command's input payload.
   *
   * Narrows `TIn` for subsequent `.argv(fn)`, `.stdin(fn)`, and `.unrepeatable(cmd, { key })` callbacks.
   *
   * @template TNewIn New validated command input payload type.
   *
   * @param {z.ZodType<TNewIn>} schema - Zod input schema.
   *
   * @returns {LocalCommandBuilder<TNewIn, TOut, THandle>} Updated immutable command builder narrowed to `TNewIn`.
   */
  input<TNewIn>(
    schema: z.ZodType<TNewIn>,
  ): LocalCommandBuilder<TNewIn, TOut, THandle>;

  /**
   * Binds the Zod validation schema for the command's parsed stdout output.
   *
   * Validates trimmed JSON or string stdout before returning from `executeLocalCommandStep`.
   *
   * @template TNewOut New validated command output payload type.
   *
   * @param {z.ZodType<TNewOut>} schema - Zod output schema.
   *
   * @returns {LocalCommandBuilder<TIn, TNewOut, THandle>} Updated immutable command builder narrowed to `TNewOut`.
   */
  output<TNewOut>(
    schema: z.ZodType<TNewOut>,
  ): LocalCommandBuilder<TIn, TNewOut, THandle>;

  /**
   * Configures a pre-flight idempotency check command that skips execution when `preCheckCmd` returns `true`.
   *
   * Prevents side-effecting commands from re-executing when their external effect is already present.
   *
   * @template TPreIn Input payload type of `preCheckCmd`.
   *
   * @param {MaybeBuilder<LocalCommandNode<TPreIn, boolean, THandle>>} preCheckCmd - Boolean pre-check command node or builder.
   * @param {LocalCommandUnrepeatableOptions<TIn>}                     options     - Deduplication key configuration.
   *
   * @returns {LocalCommandBuilder<TIn, TOut, THandle>} Updated immutable command builder.
   */
  unrepeatable<TPreIn = TIn>(
    preCheckCmd: MaybeBuilder<LocalCommandNode<TPreIn, boolean, THandle>>,
    options: LocalCommandUnrepeatableOptions<TIn>,
  ): LocalCommandBuilder<TIn, TOut, THandle>;

  /**
   * Projects this command into a passive `LocalCommandCheckNode` (`type: 'node:command-check'`).
   *
   * Reports `{ ok: true, deficits: [] }` when the command exits with code `0`.
   *
   * @returns {AstBuilder<LocalCommandCheckNode<THandle>> & LocalCommandCheckNode<THandle>} Check builder and AST descriptor.
   */
  asCheck(): AstBuilder<LocalCommandCheckNode<THandle>> & LocalCommandCheckNode<THandle>;

  /**
   * Projects this command into a post-flight-diffed `LocalCommandToolNode` (`type: 'node:command-tool'`).
   *
   * Defaults `inputSchema` to `z.object({})` when `argv` is a static array and sets
   * `effectTracking: 'subprocess-post-flight'` so workspace mutations are verified post-flight.
   *
   * @returns {AstBuilder<LocalCommandToolNode<THandle>> & LocalCommandToolNode<THandle>} Tool builder and AST descriptor.
   */
  asTool(): AstBuilder<LocalCommandToolNode<THandle>> & LocalCommandToolNode<THandle>;
}
