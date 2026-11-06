/**
 * Per-`stepExecId` asynchronous FIFO serialization queue for `ContinuationFrame[]` mutations (`SPEC.md` §3.7.2).
 *
 * Serializes all concurrent updates to a step's continuation call stack (such as sibling downward forks
 * in `'fork-batch-frame'` and speculative branches in `'speculate-frame'`) so concurrent transitions
 * never overwrite each other in `LedgerStore.updateContinuationStack`.
 */
export class StepContinuationQueue {
  /** Tail promises indexed by `stepExecId` representing the latest queued update per step. */
  private readonly queueTails = new Map<string, Promise<unknown>>();

  /**
   * Enqueues `task` behind all prior updates for `stepExecId` and returns its completion promise.
   *
   * Continues draining subsequent queued tasks for `stepExecId` even if an earlier task rejects.
   *
   * @template TResult Return type of the queued update callback.
   *
   * @param {string}                 stepExecId - Unique step execution identifier to serialize on.
   * @param {() => Promise<TResult>} task       - Asynchronous continuation update callback.
   *
   * @returns {Promise<TResult>} Promise resolving or rejecting with the outcome of `task`.
   */
  enqueueUpdate<TResult>(stepExecId: string, task: () => Promise<TResult>): Promise<TResult> {
    const previous = this.queueTails.get(stepExecId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => task());
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this.queueTails.set(stepExecId, settled);
    return current.finally(() => {
      if (this.queueTails.get(stepExecId) === settled) {
        this.queueTails.delete(stepExecId);
      }
    });
  }

  /**
   * Removes any idle tail promise entry tracked for `stepExecId`.
   *
   * Invoked when a step execution reaches a terminal state and no further stack mutations can occur.
   *
   * @param {string} stepExecId - Step execution identifier to clear.
   */
  clearStep(stepExecId: string): void {
    this.queueTails.delete(stepExecId);
  }
}
