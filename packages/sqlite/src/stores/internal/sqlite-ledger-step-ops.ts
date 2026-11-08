import type {
  InterruptedStepBootRecord,
  RecordStepStartInput,
  RecordStepTransitionInput,
} from '@paraharness/core';
import type Database from 'better-sqlite3';
import {
  mapInterruptedBootRecordFromSqlite,
  resolveRunStatusAfterStepTransition,
} from './sqlite-ledger-step-operations.js';
import type { SqliteRunRow } from './sqlite-run-row.js';
import type { SqliteStepRow } from './sqlite-step-row.js';
import type { UpdateContinuationStackParams } from './update-continuation-stack-params.js';

/**
 * Persists a step execution start record in `harness_step_executions` and updates `harness_runs`.
 *
 * Allocates a monotonic `seq_id` and records `baseScopeCheckpoint` and `continuationStack`.
 *
 * @param {Database.Database}    db   - Active SQLite database handle.
 * @param {RecordStepStartInput} step - Step start metadata and initial continuation stack.
 *
 * @returns {void} Returns nothing once the step start is committed.
 */
export function recordStepStartInSqlite(db: Database.Database, step: RecordStepStartInput): void {
  const seqRow = db
    .prepare('SELECT COALESCE(MAX(seq_id), 0) + 1 AS next_seq FROM harness_step_executions')
    .get() as { readonly next_seq: number };
  db.prepare(
    "INSERT OR REPLACE INTO harness_step_executions (step_exec_id, run_id, step_id, executable_id, input_msg_id, status, output_json, base_scope_checkpoint, head_scope_checkpoint, continuation_stack_json, telemetry_json, seq_id) VALUES (?, ?, ?, ?, ?, 'RUNNING', NULL, ?, NULL, ?, NULL, ?)",
  ).run(
    step.stepExecId,
    step.runId,
    step.stepId,
    step.executableId ?? null,
    step.inputMsgId,
    step.baseScopeCheckpoint ?? null,
    JSON.stringify(step.continuationStack),
    seqRow.next_seq,
  );
  db.prepare(
    "UPDATE harness_runs SET current_step_id = ?, status = 'RUNNING', updated_at = ? WHERE run_id = ?",
  ).run(step.stepId, new Date().toISOString(), step.runId);
}

/**
 * Updates `continuation_stack_json` and optional `base_scope_checkpoint` for `stepExecId`.
 *
 * Preserves serialized call-stack state across turns, tool batches, and child forks.
 *
 * @param {Database.Database}             db     - Active SQLite database handle.
 * @param {UpdateContinuationStackParams} params - Step continuation stack update parameters.
 *
 * @returns {void} Returns nothing once the continuation stack is updated.
 */
export function updateContinuationStackInSqlite(
  db: Database.Database,
  params: UpdateContinuationStackParams,
): void {
  const stackJson = JSON.stringify(params.continuationStack);
  if (params.baseScopeCheckpoint !== undefined) {
    db.prepare(
      'UPDATE harness_step_executions SET continuation_stack_json = ?, base_scope_checkpoint = ? WHERE step_exec_id = ? AND run_id = ?',
    ).run(stackJson, params.baseScopeCheckpoint, params.stepExecId, params.runId);
    return;
  }
  db.prepare(
    'UPDATE harness_step_executions SET continuation_stack_json = ? WHERE step_exec_id = ? AND run_id = ?',
  ).run(stackJson, params.stepExecId, params.runId);
}

/**
 * Records a step lifecycle status transition and updates `completed_step_outputs_json` on completion.
 *
 * Synchronizes the parent run status when transitioning to `'SUSPENDED'` or `'RUNNING'`.
 *
 * @param {Database.Database}         db         - Active SQLite database handle.
 * @param {RecordStepTransitionInput} transition - Step transition metadata and telemetry JSON.
 *
 * @returns {void} Returns nothing once the step transition is persisted.
 */
export function recordStepTransitionInSqlite(
  db: Database.Database,
  transition: RecordStepTransitionInput,
): void {
  const existing = db
    .prepare('SELECT * FROM harness_step_executions WHERE step_exec_id = ?')
    .get(transition.stepExecId) as SqliteStepRow | undefined;
  if (existing === undefined) {
    throw new Error(
      `Cannot transition unknown stepExecId '${transition.stepExecId}' in SQLite ledger.`,
    );
  }
  db.prepare(
    'UPDATE harness_step_executions SET status = ?, output_json = ?, base_scope_checkpoint = ?, head_scope_checkpoint = ?, telemetry_json = ? WHERE step_exec_id = ?',
  ).run(
    transition.status,
    transition.outputJson ?? existing.output_json,
    transition.baseScopeCheckpoint ?? existing.base_scope_checkpoint,
    transition.headScopeCheckpoint ?? existing.head_scope_checkpoint,
    transition.telemetryJson,
    transition.stepExecId,
  );
  const runRow = db
    .prepare('SELECT completed_step_outputs_json, status FROM harness_runs WHERE run_id = ?')
    .get(existing.run_id) as
    | { readonly completed_step_outputs_json: string; readonly status: string }
    | undefined;
  if (runRow === undefined) {
    return;
  }
  const outputs = JSON.parse(runRow.completed_step_outputs_json) as Record<string, string>;
  if (transition.status === 'COMPLETED' && transition.outputJson !== undefined) {
    outputs[existing.step_id] = transition.outputJson;
  }
  const nextRunStatus = resolveRunStatusAfterStepTransition(transition.status, runRow.status);
  db.prepare(
    'UPDATE harness_runs SET completed_step_outputs_json = ?, status = ?, updated_at = ? WHERE run_id = ?',
  ).run(JSON.stringify(outputs), nextRunStatus, new Date().toISOString(), existing.run_id);
}

/**
 * Queries all non-terminal runs (`'QUEUED' | 'RUNNING' | 'WAITING' | 'SUSPENDED'`) on startup.
 *
 * Joins each active run with its latest active step execution to reconstruct `InterruptedStepBootRecord`s.
 *
 * @param {Database.Database} db - Active SQLite database handle.
 *
 * @returns {readonly InterruptedStepBootRecord[]} Non-terminal runs requiring crash recovery.
 */
export function getInterruptedStepsOnBootFromSqlite(
  db: Database.Database,
): readonly InterruptedStepBootRecord[] {
  const runs = db
    .prepare(
      "SELECT * FROM harness_runs WHERE status IN ('QUEUED', 'RUNNING', 'WAITING', 'SUSPENDED') ORDER BY rowid ASC",
    )
    .all() as SqliteRunRow[];
  const latestStepStmt = db.prepare(
    'SELECT * FROM harness_step_executions WHERE run_id = ? ORDER BY seq_id DESC LIMIT 1',
  );
  const results: InterruptedStepBootRecord[] = [];
  for (const runRow of runs) {
    const stepRow = latestStepStmt.get(runRow.run_id) as SqliteStepRow | undefined;
    results.push(mapInterruptedBootRecordFromSqlite(runRow, stepRow));
  }
  return Object.freeze(results);
}
