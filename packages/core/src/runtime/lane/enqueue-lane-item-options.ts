/**
 * Parameters for enqueuing a work item into `LaneScheduler.enqueueItem()` (`SPEC.md` §3.10).
 *
 * Allows overriding `enqueuedAtMs`, `priorityBoost`, and explicit `dependsOn` keys (such as from `spawnTasks`).
 *
 * @template TIn Validated lane work item input type.
 */
export interface EnqueueLaneItemOptions<TIn = unknown> {
  /** Raw or pre-validated work item input payload. */
  readonly input: TIn;
  /** Optional explicit run ID override (defaults to `"run:${laneId}:${itemKey}"`). */
  readonly runId?: string;
  /** Optional enqueue timestamp in milliseconds (defaults to `Date.now()`). */
  readonly enqueuedAtMs?: number;
  /** Optional priority boost inherited from a suspended parent (`'inherit-parent-with-boost'`). */
  readonly priorityBoost?: number;
  /** Optional explicit prerequisite item keys supplementing `lane.waitFor.depsMapper`. */
  readonly additionalDeps?: readonly string[];
}
