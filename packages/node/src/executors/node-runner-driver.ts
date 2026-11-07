import type { NodeRunnerNode, RunnerDriver } from '@harness-dsl/core';
import PQueue from 'p-queue';
import { enqueueWithQueuedAbortSignal } from './internal/enqueue-with-queued-abort-signal.js';

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
  /** Active daemon slot release callbacks holding occupancy in `this.daemonQueue`. */
  private readonly activeDaemonReleases = new Set<() => void>();

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
   *
   * @throws {Error} If `signal` aborts while queued or `fn()` rejects.
   */
  async withSlot<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return enqueueWithQueuedAbortSignal<T>({
      queue: this.slotQueue,
      runnerId: this.id,
      resourceLabel: 'slot',
      signal,
      task: fn,
    });
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
   *
   * @throws {Error} If `signal` aborts while queued or `fn()` rejects.
   */
  async withDaemonSlot<T>(
    fn: (releaseDaemonSlot: () => void) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const releaseHold = await this.acquireDaemonQueueLease(signal);
    const releaseDaemonSlot = (): void => {
      if (this.activeDaemonReleases.delete(releaseHold)) {
        releaseHold();
      }
    };
    try {
      signal?.throwIfAborted();
      return await fn(releaseDaemonSlot);
    } catch (error) {
      releaseDaemonSlot();
      throw error;
    }
  }

  /**
   * Enqueues a long-lived lease task in `this.daemonQueue` and resolves with its specific release callback.
   *
   * Detaches the caller's `AbortSignal` listener as soon as the slot is granted so only queued waits abort.
   *
   * @param {AbortSignal} [signal] - Optional abort signal cancelling queued wait.
   *
   * @returns {Promise<() => void>} Release callback that frees the held `this.daemonQueue` slot.
   */
  private acquireDaemonQueueLease(signal?: AbortSignal): Promise<() => void> {
    return new Promise<() => void>((resolve, reject) => {
      void enqueueWithQueuedAbortSignal<void>({
        queue: this.daemonQueue,
        runnerId: this.id,
        resourceLabel: 'daemon',
        signal,
        task: () =>
          new Promise<void>((releaseSlotHold) => {
            this.activeDaemonReleases.add(releaseSlotHold);
            resolve(releaseSlotHold);
          }),
      }).catch(reject);
    });
  }
}
