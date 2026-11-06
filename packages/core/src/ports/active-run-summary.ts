/**
 * Summary descriptor of an active or suspended harness run returned by `HarnessRuntimeController.getActiveRuns()`.
 *
 * Captures the run identifier, owning lane, deduplication item key, and current execution lifecycle state
 * for external observability and control-plane inspection.
 */
export interface ActiveRunSummary {
  /** Unique identifier of the harness run. */
  readonly runId: string;
  /** Identifier of the lane executing the run. */
  readonly laneId: string;
  /** Deduplication key of the work item being processed. */
  readonly itemKey: string;
  /** Current lifecycle status of the run (`'QUEUED' | 'RUNNING' | 'SUSPENDED'`). */
  readonly status: string;
}
