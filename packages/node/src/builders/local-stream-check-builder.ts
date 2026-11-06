import type {
  AstBuilder,
  EnvRef,
  LocalStreamCheckNode,
  LocalStreamCheckToolNode,
  MaybeBuilder,
  NodeRunnerNode,
} from '@harness-dsl/core';
import type { LocalStreamCheckCircuitBreakerOptions } from './local-stream-check-circuit-breaker-options.js';

/**
 * Fluent builder for a streaming subprocess verification check (`local.streamCheck(id)`).
 *
 * Streams `stdout` and `stderr` into a combined rolling multi-line buffer, supports early
 * circuit-breaking on failure stack traces, and projects into a post-flight-diffed tool via `.asTool()`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface LocalStreamCheckBuilder<THandle = unknown>
  extends AstBuilder<LocalStreamCheckNode<THandle>> {
  /** Unique identifier of the streaming check. */
  readonly id: string;

  /**
   * Binds the `NodeRunnerNode` pool governing concurrency slots for this streaming check.
   *
   * Acquires a one-shot command slot via `RunnerDriver.withSlot` when the check runs.
   *
   * @param {MaybeBuilder<NodeRunnerNode>} runner - Runner pool AST node or builder.
   *
   * @returns {LocalStreamCheckBuilder<THandle>} Updated immutable stream check builder.
   */
  runner(runner: MaybeBuilder<NodeRunnerNode>): LocalStreamCheckBuilder<THandle>;

  /**
   * Binds the command argument vector executed by the streaming check.
   *
   * Index `0` of `args` specifies the executable binary and subsequent entries are arguments.
   *
   * @param {readonly string[]} args - Command argument vector.
   *
   * @returns {LocalStreamCheckBuilder<THandle>} Updated immutable stream check builder.
   */
  argv(args: readonly string[]): LocalStreamCheckBuilder<THandle>;

  /**
   * Binds static string or symbolic `EnvRef` environment variables injected into the subprocess.
   *
   * Symbolic `EnvRef` entries are resolved via `ctx.resolveEnv` at check invocation time.
   *
   * @param {Readonly<Record<string, string | EnvRef>>} envVars - Environment variable map.
   *
   * @returns {LocalStreamCheckBuilder<THandle>} Updated immutable stream check builder.
   */
  env(envVars: Readonly<Record<string, string | EnvRef>>): LocalStreamCheckBuilder<THandle>;

  /**
   * Sets the wall-clock timeout in minutes before the streaming subprocess group is terminated.
   *
   * Sends `SIGTERM` followed by `SIGKILL` to the detached process group when the timeout expires.
   *
   * @param {number} minutes - Positive timeout duration in minutes.
   *
   * @returns {LocalStreamCheckBuilder<THandle>} Updated immutable stream check builder.
   */
  timeoutMinutes(minutes: number): LocalStreamCheckBuilder<THandle>;

  /**
   * Configures a rolling-window regular expression circuit breaker over combined `stdout` and `stderr`.
   *
   * When `pattern` matches across the rolling stream buffer, collects `options.graceLinesAfterMatch`
   * trailing lines, kills the process group, and fails the check immediately.
   *
   * @param {RegExp | string}                       pattern - Regular expression or pattern string to match.
   * @param {LocalStreamCheckCircuitBreakerOptions} options - Trailing grace line capture configuration.
   *
   * @returns {LocalStreamCheckBuilder<THandle>} Updated immutable stream check builder.
   */
  circuitBreakWhenStdout(
    pattern: RegExp | string,
    options: LocalStreamCheckCircuitBreakerOptions,
  ): LocalStreamCheckBuilder<THandle>;

  /**
   * Projects this streaming check into a post-flight-diffed `LocalStreamCheckToolNode` (`type: 'node:stream-check-tool'`).
   *
   * Sets `effectTracking: 'subprocess-post-flight'` and omits `describeEffects` so workspace mutations
   * performed during a test run are verified post-flight via `CheckpointableScope.diffEffects()`.
   *
   * @returns {AstBuilder<LocalStreamCheckToolNode<THandle>> & LocalStreamCheckToolNode<THandle>} Tool builder and AST descriptor.
   */
  asTool(): AstBuilder<LocalStreamCheckToolNode<THandle>> & LocalStreamCheckToolNode<THandle>;
}
