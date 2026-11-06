/**
 * Runtime concurrency limiter for one-shot subprocess slots and background daemon sessions.
 *
 * Resolved from `RunnerPoolASTNode` via `RuntimeExecutorRegistry.runners[node.type]` and
 * memoized per `node.id` inside the active runtime.
 */
export interface RunnerDriver {
  /** Logical identifier of the runner pool. */
  readonly id: string;

  /**
   * Acquires a one-shot command execution slot for the duration of `fn()`.
   *
   * Queues the caller when all pool slots are occupied and releases the slot automatically in a `finally` block.
   *
   * @template T Return value type of `fn`.
   *
   * @param {() => Promise<T>} fn       - Asynchronous work callback executed while holding the slot.
   * @param {AbortSignal}      [signal] - Optional abort signal that cancels slot acquisition or execution.
   *
   * @returns {Promise<T>} Result produced by `fn()`.
   */
  withSlot<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;

  /**
   * Acquires a long-lived background daemon slot until `releaseDaemonSlot()` is invoked.
   *
   * Holds the concurrency slot beyond the startup promise resolution until the service session stops or is quiesced.
   *
   * @template T Return value type of `fn`.
   *
   * @param {(releaseDaemonSlot: () => void) => Promise<T>} fn       - Startup callback receiving the explicit release handle.
   * @param {AbortSignal}                                   [signal] - Optional abort signal that cancels daemon slot acquisition.
   *
   * @returns {Promise<T>} Result produced by `fn()`.
   */
  withDaemonSlot<T>(
    fn: (releaseDaemonSlot: () => void) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}
