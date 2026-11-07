import PQueue from 'p-queue';

/**
 * Per-`stepExecId` asynchronous FIFO serialization queue for `ContinuationFrame[]` mutations (`SPEC.md` §3.7.2).
 *
 * Coordinates all concurrent updates to a step's continuation call stack via a per-step
 * `PQueue` (`concurrency: 1`) so sibling downward forks and speculative branches never
 * overwrite each other in `LedgerStore.updateContinuationStack`.
 */
export class StepContinuationQueue {
  /** Active `PQueue` instances (`concurrency: 1`) indexed by `stepExecId`. */
  private readonly queues = new Map<string, PQueue>();

  /**
   * Enqueues `task` behind all prior updates for `stepExecId` and returns its completion promise.
   *
   * Continues draining subsequent queued tasks for `stepExecId` even if an earlier task rejects
   * or is cancelled via `signal`, and evicts the step's `PQueue` instance once idle.
   *
   * @template TResult Return type of the queued update callback.
   *
   * @param {string}                 stepExecId - Unique step execution identifier to serialize on.
   * @param {() => Promise<TResult>} task       - Asynchronous continuation update callback.
   * @param {AbortSignal}            [signal]   - Optional cancellation signal for queued updates.
   *
   * @returns {Promise<TResult>} Promise resolving or rejecting with the outcome of `task`.
   */
  async enqueueUpdate<TResult>(
    stepExecId: string,
    task: () => Promise<TResult>,
    signal?: AbortSignal,
  ): Promise<TResult> {
    signal?.throwIfAborted();
    const queue = this.getOrCreateQueue(stepExecId);
    const waitController = new AbortController();
    let onWaitAbort: (() => void) | undefined;
    if (signal !== undefined) {
      onWaitAbort = (): void => waitController.abort(signal.reason);
      signal.addEventListener('abort', onWaitAbort, { once: true });
    }
    try {
      return await queue.add(
        () => {
          if (onWaitAbort !== undefined && signal !== undefined) {
            signal.removeEventListener('abort', onWaitAbort);
            onWaitAbort = undefined;
          }
          return task();
        },
        { signal: waitController.signal },
      );
    } finally {
      if (onWaitAbort !== undefined && signal !== undefined) {
        signal.removeEventListener('abort', onWaitAbort);
      }
      await Promise.resolve();
      await Promise.resolve();
      this.evictIfIdle(stepExecId, queue);
    }
  }

  /**
   * Checks whether `stepExecId` currently holds an active or queued `PQueue` instance.
   *
   * Returns `false` once all pending and queued continuation updates for `stepExecId` have drained.
   *
   * @param {string} stepExecId - Step execution identifier to inspect.
   *
   * @returns {boolean} True when a non-evicted queue entry exists for `stepExecId`.
   */
  hasStepQueue(stepExecId: string): boolean {
    return this.queues.has(stepExecId);
  }

  /**
   * Clears and removes any `PQueue` entry tracked for `stepExecId`.
   *
   * Invoked when a step execution reaches a terminal state and no further stack mutations can occur.
   *
   * @param {string} stepExecId - Step execution identifier to clear.
   */
  clearStep(stepExecId: string): void {
    const queue = this.queues.get(stepExecId);
    if (queue !== undefined) {
      queue.clear();
      this.queues.delete(stepExecId);
    }
  }

  /**
   * Looks up or creates the serialized `PQueue` (`concurrency: 1`) for `stepExecId`.
   *
   * Attaches an `'idle'` listener that automatically evicts the queue when `size === 0 && pending === 0`.
   *
   * @param {string} stepExecId - Step execution identifier key.
   *
   * @returns {PQueue} Existing or newly initialized single-concurrency queue.
   */
  private getOrCreateQueue(stepExecId: string): PQueue {
    const existing = this.queues.get(stepExecId);
    if (existing !== undefined) {
      return existing;
    }
    const created = new PQueue({ concurrency: 1 });
    created.on('idle', () => {
      this.evictIfIdle(stepExecId, created);
    });
    this.queues.set(stepExecId, created);
    return created;
  }

  /**
   * Evicts `queue` from `this.queues` when `queue.size === 0 && queue.pending === 0`.
   *
   * Ensures completed `stepExecId` entries never leak across long-running harness processes.
   *
   * @param {string} stepExecId - Step execution identifier key.
   * @param {PQueue} queue      - Candidate `PQueue` instance to evict if idle.
   */
  private evictIfIdle(stepExecId: string, queue: PQueue): void {
    if (queue.size === 0 && queue.pending === 0 && this.queues.get(stepExecId) === queue) {
      this.queues.delete(stepExecId);
    }
  }
}
