import type { ContinuationFrame, InterruptedStepBootRecord } from '@paraharness/core';
import type { PgRunRow } from './pg-run-row.js';
import type { PgStepRow } from './pg-step-row.js';

/**
 * Maps a non-terminal `PgRunRow`, its latest `PgStepRow`, and its `dependsOn` list into an `InterruptedStepBootRecord`.
 *
 * Populates active step checkpoints and parsed `ContinuationFrame[]` only when the latest step
 * is in `'RUNNING'` or `'SUSPENDED'` state.
 *
 * @param {PgRunRow}               runRow    - Non-terminal flow run row.
 * @param {PgStepRow | undefined}  stepRow   - Latest step execution row for `runRow.run_id`, if any.
 * @param {readonly string[]}      dependsOn - Direct prerequisite `item_key` list for the run's lane item.
 *
 * @returns {InterruptedStepBootRecord} Frozen boot recovery record.
 */
export function mapInterruptedBootRecordFromPg(
  runRow: PgRunRow,
  stepRow: PgStepRow | undefined,
  dependsOn: readonly string[],
): InterruptedStepBootRecord {
  const isActiveStep =
    stepRow !== undefined && (stepRow.status === 'RUNNING' || stepRow.status === 'SUSPENDED');
  const stack: readonly ContinuationFrame[] = isActiveStep
    ? (JSON.parse(stepRow.continuation_stack_json) as ContinuationFrame[])
    : [];
  return Object.freeze<InterruptedStepBootRecord>({
    runId: runRow.run_id,
    laneId: runRow.lane_id,
    itemKey: runRow.item_key,
    inputJson: runRow.input_json,
    status: runRow.status as 'QUEUED' | 'RUNNING' | 'WAITING' | 'SUSPENDED',
    dependsOn: Object.freeze([...dependsOn]),
    stepExecId: isActiveStep ? stepRow.step_exec_id : null,
    stepId: isActiveStep ? stepRow.step_id : null,
    executableId: isActiveStep ? (stepRow.executable_id ?? undefined) : undefined,
    baseScopeCheckpoint: isActiveStep ? (stepRow.base_scope_checkpoint ?? undefined) : undefined,
    headScopeCheckpoint: isActiveStep ? (stepRow.head_scope_checkpoint ?? undefined) : undefined,
    continuationStack: Object.freeze([...stack]),
  });
}
