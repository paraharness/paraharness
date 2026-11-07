# Lessons (Reviewer)

- **[PQueue.add / AbortSignal]** Flag any `PQueue({ concurrency: 1 }).add(fn, { signal })` call that passes a caller `AbortSignal` directly to `p-queue` without disconnecting it once the queued turn starts when `fn()` must hold the concurrency slot until completion, because `p-queue` races already-started tasks against `signal` and releases the `concurrency: 1` slot to the next waiter while `fn()` is still running in flight.
