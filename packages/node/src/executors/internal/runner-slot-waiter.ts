/**
 * Queued waiter entry inside `NodeRunnerDriver` for one-shot or daemon concurrency slots.
 *
 * Holds the wakeup callback and optional `AbortSignal` cleanup hook while waiting for a slot.
 */
export interface RunnerSlotWaiter {
  /** Callback invoked when a slot is granted to this waiter. */
  readonly grant: () => void;
  /** Cleanup callback that removes the abort listener once granted. */
  readonly cleanup: () => void;
}
