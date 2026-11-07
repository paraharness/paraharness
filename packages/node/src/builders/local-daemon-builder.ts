import type {
  AstBuilder,
  LocalServiceNode,
  MaybeBuilder,
  NodeRunnerNode,
  z,
} from '@harness-dsl/core';

/**
 * Runtime context supplied to `local.daemon` `.start()`, `.stopCommand()`, and `.interact()` command factories.
 *
 * Provides dynamically allocated conflict-free TCP ports, the collision-free hash-suffixed `scopeKey`,
 * and the optional isolation scope `worktreePath`.
 */
export interface LocalDaemonCommandContext {
  /** Dynamically allocated conflict-free TCP port numbers keyed by `.port(name)`. */
  readonly ports: Readonly<Record<string, number>>;
  /** Sanitized and SHA-256-suffixed scope key (`${sanitizedPrefix}-${sha256(rawScopeKey).slice(0, 8)}`). */
  readonly scopeKey: string;
  /** Optional filesystem path of the active isolation scope worktree. */
  readonly worktreePath?: string;
}

/**
 * Serializable regular expression descriptor used for `frameDelimiter` when specified as a pattern record.
 *
 * Stores the regex pattern string and optional regex flags for passive AST serialization.
 */
export interface LocalDaemonRegexDescriptor {
  /** Regular expression pattern source string. */
  readonly pattern: string;
  /** Optional regular expression flags (e.g. `'m'`, `'i'`). */
  readonly flags?: string;
}

/**
 * Configuration options for registering a framed PTY interaction tool on `local.daemon(id).interact(toolName, options)`.
 *
 * Defines the command factory, prompt frame delimiter, output settle quiet window, and turn timeout.
 *
 * @template TInput Validated tool input payload type (defaults to `{ readonly input: string }`).
 */
export interface LocalDaemonInteractOptions<TInput = { readonly input: string }> {
  /** Optional human-readable tool description (defaults to `` `Interact with service via ${toolName}` ``). */
  readonly description?: string;
  /** Optional Zod input validation schema (defaults to `z.object({ input: z.string() })`). */
  readonly inputSchema?: z.ZodType<TInput>;
  /** Pure factory mapping allocated ports, sanitized `scopeKey`, and `worktreePath` to the interactive CLI `argv`. */
  readonly command: (ctx: LocalDaemonCommandContext) => readonly string[];
  /** Prompt delimiter string, `RegExp`, or serialized pattern descriptor marking the end of each output frame. */
  readonly frameDelimiter: string | RegExp | LocalDaemonRegexDescriptor;
  /** Quiet window in milliseconds after `frameDelimiter` matches before resolving the turn output. */
  readonly idleSettleMs: number;
  /** Maximum timeout in seconds for draining the banner or completing a single interactive turn. */
  readonly timeoutSeconds: number;
}

/**
 * Fluent builder for a lifecycle-bound background daemon service (`local.daemon(id)`).
 *
 * Configures dynamic TCP port allocation, pre-start cleanup and shutdown commands, combined
 * `stdout`/`stderr` readiness regexes, and framed pseudo-terminal (PTY) interaction tools.
 */
export interface LocalDaemonBuilder extends AstBuilder<LocalServiceNode> {
  /** Unique identifier of the daemon service. */
  readonly id: string;

  /**
   * Binds the `NodeRunnerNode` pool governing `maxDaemons` concurrency slots for this service.
   *
   * Acquires a daemon slot via `RunnerDriver.withDaemonSlot` for the duration of the active `ServiceSession`.
   *
   * @param {MaybeBuilder<NodeRunnerNode>} runner - Runner pool AST node or builder.
   *
   * @returns {LocalDaemonBuilder} Updated immutable daemon builder.
   */
  runner(runner: MaybeBuilder<NodeRunnerNode>): LocalDaemonBuilder;

  /**
   * Sets the lifecycle scope (`'scope' | 'fork' | 'skill'`) governing daemon startup and teardown.
   *
   * Controls when the runtime automatically starts, quiesces, and stops the daemon process.
   *
   * @param {'scope' | 'fork' | 'skill'} mode - Service lifecycle binding mode.
   *
   * @returns {LocalDaemonBuilder} Updated immutable daemon builder.
   */
  lifecycle(mode: 'scope' | 'fork' | 'skill'): LocalDaemonBuilder;

  /**
   * Declares a named dynamic TCP port to allocate conflict-free before starting the daemon.
   *
   * Verifies TCP listener readiness on the allocated port before resolving service acquisition.
   *
   * @param {string} name - Logical port key exposed on `ctx.ports[name]`.
   *
   * @returns {LocalDaemonBuilder} Updated immutable daemon builder.
   */
  port(name: string): LocalDaemonBuilder;

  /**
   * Binds the pure factory function producing the startup command `argv` for the daemon.
   *
   * Receives allocated `ports`, the hash-suffixed `scopeKey`, and optional `worktreePath`.
   *
   * @param {(ctx: LocalDaemonCommandContext) => readonly string[]} startFn - Startup `argv` factory.
   *
   * @returns {LocalDaemonBuilder} Updated immutable daemon builder.
   */
  start(startFn: (ctx: LocalDaemonCommandContext) => readonly string[]): LocalDaemonBuilder;

  /**
   * Binds an optional cleanup/stop command factory executed best-effort before `.start()` and during `.stop()`.
   *
   * Reaps crash-orphaned containers or external processes bound to the same `scopeKey`.
   *
   * @param {(ctx: LocalDaemonCommandContext) => readonly string[]} stopFn - Cleanup `argv` factory.
   *
   * @returns {LocalDaemonBuilder} Updated immutable daemon builder.
   */
  stopCommand(stopFn: (ctx: LocalDaemonCommandContext) => readonly string[]): LocalDaemonBuilder;

  /**
   * Configures a readiness regular expression evaluated over combined `stdout` and `stderr` during startup.
   *
   * Blocks service session resolution until the rolling output buffer matches `pattern` and all TCP ports listen.
   *
   * @param {RegExp | string} pattern - Regular expression or pattern string indicating daemon readiness.
   *
   * @returns {LocalDaemonBuilder} Updated immutable daemon builder.
   */
  readyWhenStdout(pattern: RegExp | string): LocalDaemonBuilder;

  /**
   * Registers a framed PTY interaction tool exposed while the daemon service is active.
   *
   * Populates `LocalServiceNode.toolSchemas` up front so wire tool definitions remain static across
   * skill activation and deactivation.
   *
   * @template TInput Validated tool input payload type.
   *
   * @param {string}                             toolName - Unique tool name exposed to the agent.
   * @param {LocalDaemonInteractOptions<TInput>} options  - Interactive PTY command and framing configuration.
   *
   * @returns {LocalDaemonBuilder} Updated immutable daemon builder.
   */
  interact<TInput = { readonly input: string }>(
    toolName: string,
    options: LocalDaemonInteractOptions<TInput>,
  ): LocalDaemonBuilder;
}
