import type { ContinuationFrame, InterruptedStepBootRecord } from '@paraharness/core';
import type { SqliteRunRow } from './sqlite-run-row.js';
import type { SqliteStepRow } from './sqlite-step-row.js';

/**
 * Computes the next parent run status following a step lifecycle status transition.
 *
 * Transitions the parent run to `'SUSPENDED'` or `'RUNNING'` when the step enters those states,
 * preserving `currentRunStatus` otherwise.
 *
 * @param {string} stepTransitionStatus - Newly recorded step status.
 * @param {string} currentRunStatus     - Current status of the enclosing flow run.
 *
 * @returns {string} Updated flow run status string.
 */
export function resolveRunStatusAfterStepTransition(
  stepTransitionStatus: string,
  currentRunStatus: string,
): string {
  if (stepTransitionStatus === 'SUSPENDED') {
    return 'SUSPENDED';
  }
  if (stepTransitionStatus === 'RUNNING') {
    return 'RUNNING';
  }
  return currentRunStatus;
}

/**
 * Maps a non-terminal `SqliteRunRow` and its latest `SqliteStepRow` into an `InterruptedStepBootRecord`.
 *
 * Populates active step checkpoints and parsed `ContinuationFrame[]` only when the latest step
 * is in `'RUNNING'` or `'SUSPENDED'` state.
 *
 * @param {SqliteRunRow}             runRow  - Non-terminal flow run row.
 * @param {SqliteStepRow | undefined} stepRow - Latest step execution row for `runRow.run_id`, if any.
 *
 * @returns {InterruptedStepBootRecord} Frozen boot recovery record.
 */
export function mapInterruptedBootRecordFromSqlite(
  runRow: SqliteRunRow,
  stepRow: SqliteStepRow | undefined,
): InterruptedStepBootRecord {
  const isActiveStep =
    stepRow !== undefined && (stepRow.status === 'RUNNING' || stepRow.status === 'SUSPENDED');
  const stack: readonly ContinuationFrame[] = isActiveStep
    ? (JSON.parse(stepRow.continuation_stack_json) as ContinuationFrame[])
    : [];
  const dependsOn = JSON.parse(runRow.depends_on_json) as string[];
  return Object.freeze<InterruptedStepBootRecord>({
    runId: runRow.run_id,
    laneId: runRow.lane_id,
    itemKey: runRow.item_key,
    inputJson: runRow.input_json,
    status: runRow.status as 'QUEUED' | 'RUNNING' | 'WAITING' | 'SUSPENDED',
    dependsOn: Object.freeze(dependsOn),
    stepExecId: isActiveStep ? stepRow.step_exec_id : null,
    stepId: isActiveStep ? stepRow.step_id : null,
    executableId: isActiveStep ? (stepRow.executable_id ?? undefined) : undefined,
    baseScopeCheckpoint: isActiveStep ? (stepRow.base_scope_checkpoint ?? undefined) : undefined,
    headScopeCheckpoint: isActiveStep ? (stepRow.head_scope_checkpoint ?? undefined) : undefined,
    continuationStack: Object.freeze(stack),
  });
}
