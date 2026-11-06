import type { NodeRunnerNode, RunnerDriver } from '@harness-dsl/core';
import type { RunnerSlotWaiter } from './internal/runner-slot-waiter.js';

/**
 * Runtime concurrency limiter implementing `RunnerDriver` for `NodeRunnerNode` (`local.runner`).
 *
 * Maintains independent FIFO semaphores for one-shot subprocess slots (`withSlot`, bounded by `slots`)
 * and long-lived background daemon sessions (`withDaemonSlot`, bounded by `maxDaemons`) so active
 * daemons never starve one-shot build or test commands.
 */
export class NodeRunnerDriver implements RunnerDriver {
  /** Logical identifier of the runner pool. */
  readonly id: string;
  /** Maximum concurrent one-shot command executions. */
  readonly slots: number;
  /** Maximum concurrent background daemon sessions. */
  readonly maxDaemons: number;
  /** Currently occupied one-shot command slots. */
  private activeSlots = 0;
  /** Currently occupied background daemon slots. */
  private activeDaemons = 0;
  /** FIFO wait queue for one-shot command slots. */
  private readonly slotQueue: RunnerSlotWaiter[] = [];
  /** FIFO wait queue for background daemon slots. */
  private readonly daemonQueue: RunnerSlotWaiter[] = [];

  /**
   * Initializes a `NodeRunnerDriver` from a compiled `NodeRunnerNode`.
   *
   * Sets the pool identifier, one-shot slot ceiling, and daemon slot ceiling.
   *
   * @param {NodeRunnerNode} node - Passive runner pool AST node.
   */
  constructor(node: NodeRunnerNode) {
    this.id = node.id;
    this.slots = node.slots;
    this.maxDaemons = node.maxDaemons;
  }

  /**
   * Acquires a one-shot command execution slot for the duration of `fn()`.
   *
   * Queues the caller when all `slots` are occupied, cancels wait-queue registration immediately
   * if `signal` aborts, and releases the slot in `finally`.
   *
   * @template T Return value type of `fn`.
   *
   * @param {() => Promise<T>} fn       - Asynchronous callback executed while holding the slot.
   * @param {AbortSignal}      [signal] - Optional abort signal cancelling slot acquisition or execution.
   *
   * @returns {Promise<T>} Result produced by `fn()`.
   */
  async withSlot<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquireFromPool('slot', signal);
    try {
      signal?.throwIfAborted();
      return await fn();
    } finally {
      this.releaseToPool('slot');
    }
  }

  /**
   * Acquires a long-lived background daemon slot until `releaseDaemonSlot()` is invoked.
   *
   * Holds the daemon slot across the lifetime of the `ServiceSession` and automatically releases
   * the slot if the startup callback `fn` throws before returning.
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
    await this.acquireFromPool('daemon', signal);
    let released = false;
    const releaseDaemonSlot = (): void => {
      if (released) return;
      released = true;
      this.releaseToPool('daemon');
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
   * Acquires a slot from either the one-shot `'slot'` pool or the `'daemon'` pool.
   *
   * Enqueues a `RunnerSlotWaiter` when at capacity and removes the waiter immediately if `signal` fires.
   *
   * @param {'slot' | 'daemon'} kind     - Semaphore pool kind to acquire.
   * @param {AbortSignal}       [signal] - Optional abort signal.
   *
   * @returns {Promise<void>} Resolves when the slot is granted.
   */
  private acquireFromPool(kind: 'slot' | 'daemon', signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const isSlot = kind === 'slot';
    const current = isSlot ? this.activeSlots : this.activeDaemons;
    const limit = isSlot ? this.slots : this.maxDaemons;
    if (current < limit) {
      if (isSlot) this.activeSlots += 1;
      else this.activeDaemons += 1;
      return Promise.resolve();
    }
    const queue = isSlot ? this.slotQueue : this.daemonQueue;
    return new Promise<void>((resolve, reject) => {
      let onAbort: (() => void) | undefined;
      const cleanup = (): void => {
        if (onAbort !== undefined && signal !== undefined) {
          signal.removeEventListener('abort', onAbort);
        }
      };
      const waiter: RunnerSlotWaiter = { grant: resolve, cleanup };
      if (signal !== undefined) {
        onAbort = (): void => {
          const idx = queue.indexOf(waiter);
          if (idx !== -1) queue.splice(idx, 1);
          cleanup();
          reject(new Error(`Aborted while waiting for ${kind} in runner '${this.id}'.`));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      queue.push(waiter);
    });
  }

  /**
   * Releases a slot back to either the `'slot'` pool or the `'daemon'` pool and wakes the next waiter.
   *
   * Transfers ownership directly to the head of the wait queue when non-empty.
   *
   * @param {'slot' | 'daemon'} kind - Semaphore pool kind to release.
   */
  private releaseToPool(kind: 'slot' | 'daemon'): void {
    const isSlot = kind === 'slot';
    const queue = isSlot ? this.slotQueue : this.daemonQueue;
    const next = queue.shift();
    if (next !== undefined) {
      next.cleanup();
      next.grant();
      return;
    }
    if (isSlot) {
      this.activeSlots = Math.max(0, this.activeSlots - 1);
    } else {
      this.activeDaemons = Math.max(0, this.activeDaemons - 1);
    }
  }
}
