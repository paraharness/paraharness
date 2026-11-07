import type { NodeRunnerNode, RunnerDriver } from '@harness-dsl/core';
import PQueue from 'p-queue';

/**
 * Runtime concurrency limiter implementing `RunnerDriver` for `NodeRunnerNode` (`local.runner`).
 *
 * Maintains independent `PQueue` concurrency pools for one-shot subprocess slots (`withSlot`, bounded
 * by `slots`) and long-lived background daemon sessions (`withDaemonSlot`, bounded by `maxDaemons`) so
 * active daemons never starve one-shot build or test commands.
 */
export class NodeRunnerDriver implements RunnerDriver {
  /** Logical identifier of the runner pool. */
  readonly id: string;
  /** Maximum concurrent one-shot command executions. */
  readonly slots: number;
  /** Maximum concurrent background daemon sessions. */
  readonly maxDaemons: number;
  /** FIFO `PQueue` governing one-shot command slots. */
  private readonly slotQueue: PQueue;
  /** FIFO `PQueue` governing background daemon slots. */
  private readonly daemonQueue: PQueue;

  /**
   * Initializes a `NodeRunnerDriver` from a compiled `NodeRunnerNode`.
   *
   * Sets the pool identifier and initializes independent `PQueue` instances for `slots` and `maxDaemons`.
   *
   * @param {NodeRunnerNode} node - Passive runner pool AST node.
   */
  constructor(node: NodeRunnerNode) {
    this.id = node.id;
    this.slots = node.slots;
    this.maxDaemons = node.maxDaemons;
    this.slotQueue = new PQueue({ concurrency: node.slots });
    this.daemonQueue = new PQueue({ concurrency: node.maxDaemons });
  }

  /**
   * Acquires a one-shot command execution slot for the duration of `fn()`.
   *
   * Queues the caller in `this.slotQueue` when all `slots` are occupied, cancels queued waits
   * immediately if `signal` aborts, detaches the wait-abort listener once dequeued so in-flight
   * cleanup holds the slot until `fn()` settles, and releases the slot in `finally`.
   *
   * @template T Return value type of `fn`.
   *
   * @param {() => Promise<T>} fn       - Asynchronous callback executed while holding the slot.
   * @param {AbortSignal}      [signal] - Optional abort signal cancelling slot acquisition or execution.
   *
   * @returns {Promise<T>} Result produced by `fn()`.
   */
  async withSlot<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const waitController = new AbortController();
    let onWaitAbort: (() => void) | undefined;
    if (signal !== undefined) {
      onWaitAbort = (): void => waitController.abort();
      signal.addEventListener('abort', onWaitAbort, { once: true });
    }
    try {
      return await this.slotQueue.add<T>(
        async () => {
          if (onWaitAbort !== undefined && signal !== undefined) {
            signal.removeEventListener('abort', onWaitAbort);
            onWaitAbort = undefined;
          }
          signal?.throwIfAborted();
          return fn();
        },
        { signal: waitController.signal },
      );
    } catch (error) {
      if (waitController.signal.aborted) {
        throw new Error(`Aborted while waiting for slot in runner '${this.id}'.`);
      }
      throw error;
    } finally {
      if (onWaitAbort !== undefined && signal !== undefined) {
        signal.removeEventListener('abort', onWaitAbort);
      }
    }
  }

  /**
   * Acquires a long-lived background daemon slot until `releaseDaemonSlot()` is invoked.
   *
   * Holds a concurrency slot in `this.daemonQueue` across the lifetime of the `ServiceSession` and
   * automatically releases the slot if the startup callback `fn` throws before returning.
   *
   * @template T Return value type of `fn`.
   *
   * @param {(releaseDaemonSlot: () => void) => Promise<T>} fn       - Daemon startup callback receiving the release handle.
   * @param {AbortSignal}                                   [signal] - Optional abort signal cancelling daemon slot acquisition.
   *
   * @returns {Promise<T>} Result produced by `fn()`.
   */
  async withDaemonSlot<T>(
    fn: (releaseDaemonSlot: () => void) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    await this.acquireDaemonQueueLease(signal);
    let released = false;
    const releaseDaemonSlot = (): void => {
      if (released) return;
      released = true;
      this.releaseNextDaemonHold();
    };
    try {
      signal?.throwIfAborted();
      return await fn(releaseDaemonSlot);
    } catch (error) {
      releaseDaemonSlot();
      throw error;
    }
  }

  /** Active daemon slot release callbacks holding occupancy in `this.daemonQueue`. */
  private readonly activeDaemonReleases: Array<() => void> = [];

  /**
   * Enqueues a long-lived lease task in `this.daemonQueue` and resolves once the slot is granted.
   *
   * Detaches the caller's `AbortSignal` listener as soon as the slot is granted so only queued waits abort.
   *
   * @param {AbortSignal} [signal] - Optional abort signal cancelling queued wait.
   *
   * @returns {Promise<void>} Resolves once the daemon slot is granted.
   */
  private acquireDaemonQueueLease(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const waitController = new AbortController();
    let onWaitAbort: (() => void) | undefined;
    if (signal !== undefined) {
      onWaitAbort = (): void => waitController.abort();
      signal.addEventListener('abort', onWaitAbort, { once: true });
    }
    return new Promise<void>((resolve, reject) => {
      void this.daemonQueue
        .add(
          () =>
            new Promise<void>((releaseSlotHold) => {
              if (onWaitAbort !== undefined && signal !== undefined) {
                signal.removeEventListener('abort', onWaitAbort);
                onWaitAbort = undefined;
              }
              this.activeDaemonReleases.push(releaseSlotHold);
              resolve();
            }),
          { signal: waitController.signal },
        )
        .catch((error: unknown) => {
          if (onWaitAbort !== undefined && signal !== undefined) {
            signal.removeEventListener('abort', onWaitAbort);
            onWaitAbort = undefined;
          }
          if (waitController.signal.aborted) {
            reject(new Error(`Aborted while waiting for daemon in runner '${this.id}'.`));
            return;
          }
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  /**
   * Releases one held daemon slot in `this.daemonQueue`.
   *
   * Invokes the earliest active daemon slot release callback so the next queued daemon can start.
   */
  private releaseNextDaemonHold(): void {
    const release = this.activeDaemonReleases.shift();
    release?.();
  }
}
