/**
 * Input record passed to `LedgerStore.recordStepTransition()`.
 *
 * Records a step lifecycle transition along with optional serialized output, scope checkpoints,
 * and universal step telemetry.
 */
export interface RecordStepTransitionInput {
  /** Unique step execution identifier. */
  readonly stepExecId: string;
  /** Target step status (`'RUNNING' | 'COMPLETED' | 'INTERRUPTED' | 'FAILED' | 'SUSPENDED'`). */
  readonly status: 'RUNNING' | 'COMPLETED' | 'INTERRUPTED' | 'FAILED' | 'SUSPENDED';
  /** Optional JSON-serialized step output when `status === 'COMPLETED'`. */
  readonly outputJson?: string;
  /** Optional updated base scope checkpoint (such as after `syncRoot` wakeup). */
  readonly baseScopeCheckpoint?: string;
  /** Optional head scope checkpoint captured upon `'SUSPENDED'` transition. */
  readonly headScopeCheckpoint?: string;
  /** JSON-serialized `UniversalStepTelemetry` snapshot. */
  readonly telemetryJson: string;
}
