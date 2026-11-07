import type PQueue from 'p-queue';

/**
 * Parameters for enqueuing a task on a `PQueue` with queued-wait-only `AbortSignal` cancellation.
 *
 * Supplies the target queue, runner identifier, resource label for error messages, optional signal,
 * and the asynchronous task callback.
 *
 * @template T Return value type of `task`.
 */
export interface EnqueueWithQueuedAbortSignalParams<T> {
  /** Target `PQueue` instance governing concurrency slots. */
  readonly queue: PQueue;
  /** Logical identifier of the runner pool for abort diagnostics. */
  readonly runnerId: string;
  /** Resource label (`'slot'` or `'daemon'`) reported when a queued wait is aborted. */
  readonly resourceLabel: string;
  /** Optional abort signal cancelling the queued wait before dequeue. */
  readonly signal?: AbortSignal;
  /** Asynchronous callback executed once the concurrency slot is granted. */
  readonly task: () => Promise<T>;
}

/**
 * Enqueues `params.task` on `params.queue` while restricting `PQueue` abort cancellation to the queued wait phase.
 *
 * Detaches the `AbortSignal` listener as soon as `params.queue` grants the concurrency slot so in-flight
 * tasks hold their slot until `params.task()` settles, and removes the listener in `finally`.
 *
 * @template T Return value type of `params.task`.
 *
 * @param {EnqueueWithQueuedAbortSignalParams<T>} params - Queue, runner metadata, signal, and task callback.
 *
 * @returns {Promise<T>} Resolved value from `params.task()`.
 *
 * @throws {Error} If `params.signal` is already aborted or aborts while waiting in the queue.
 */
export async function enqueueWithQueuedAbortSignal<T>(
  params: EnqueueWithQueuedAbortSignalParams<T>,
): Promise<T> {
  params.signal?.throwIfAborted();
  const waitController = new AbortController();
  const onWaitAbort = (): void => {
    waitController.abort();
  };
  params.signal?.addEventListener('abort', onWaitAbort, { once: true });
  try {
    return await params.queue.add<T>(
      async () => {
        params.signal?.removeEventListener('abort', onWaitAbort);
        params.signal?.throwIfAborted();
        return params.task();
      },
      { signal: waitController.signal },
    );
  } catch (error) {
    if (waitController.signal.aborted) {
      throw new Error(
        `Aborted while waiting for ${params.resourceLabel} in runner '${params.runnerId}'.`,
      );
    }
    throw error;
  } finally {
    params.signal?.removeEventListener('abort', onWaitAbort);
  }
}
