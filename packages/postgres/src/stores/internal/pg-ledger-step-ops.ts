import type { ContinuationFrame, InterruptedStepBootRecord, RecordStepStartInput, RecordStepTransitionInput } from '@harness-dsl/core';
import type { PostgresQueryClient } from '../../ddl/postgres-query-client.js';
import type { PgRunRow } from './pg-run-row.js';
import type { PgStepRow } from './pg-step-row.js';
import type { UpdateContinuationStackParams } from './update-continuation-stack-params.js';

/**
 * Records the start of a flow step execution and initializes its `ContinuationFrame[]` stack in PostgreSQL.
 *
 * Upserts into `harness_steps` and updates `harness_runs.current_step_id`.
 *
 * @param {PostgresQueryClient}  client - Active PostgreSQL query client.
 * @param {RecordStepStartInput} step   - Step execution metadata and initial continuation stack.
 *
 * @returns {Promise<void>} Resolves once the step start is committed.
 */
export async function recordStepStartInPg(
  client: PostgresQueryClient,
  step: RecordStepStartInput,
): Promise<void> {
  const now = new Date().toISOString();
  await client.query(
    'INSERT INTO harness_steps (step_exec_id, run_id, step_id, executable_id, input_msg_id, status, output_json, base_scope_checkpoint, head_scope_checkpoint, continuation_stack_json, telemetry_json) VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, NULL, $8, NULL) ON CONFLICT (step_exec_id) DO UPDATE SET run_id = EXCLUDED.run_id, step_id = EXCLUDED.step_id, executable_id = EXCLUDED.executable_id, input_msg_id = EXCLUDED.input_msg_id, status = EXCLUDED.status, base_scope_checkpoint = EXCLUDED.base_scope_checkpoint, continuation_stack_json = EXCLUDED.continuation_stack_json',
    [step.stepExecId, step.runId, step.stepId, step.executableId ?? null, step.inputMsgId, 'RUNNING', step.baseScopeCheckpoint ?? null, JSON.stringify(step.continuationStack)],
  );
  await client.query("UPDATE harness_runs SET current_step_id = $1, status = 'RUNNING', updated_at = $2 WHERE run_id = $3", [step.stepId, now, step.runId]);
}

/**
 * Atomically updates the serialized `ContinuationFrame[]` stack for `params.stepExecId` in PostgreSQL.
 *
 * Optionally updates `base_scope_checkpoint` when provided in `params`.
 *
 * @param {PostgresQueryClient}           client - Active PostgreSQL query client.
 * @param {UpdateContinuationStackParams} params - Continuation stack update parameters.
 *
 * @returns {Promise<void>} Resolves once the continuation stack is persisted.
 */
export async function updateContinuationStackInPg(
  client: PostgresQueryClient,
  params: UpdateContinuationStackParams,
): Promise<void> {
  const stackJson = JSON.stringify(params.continuationStack);
  if (params.baseScopeCheckpoint !== undefined) {
    await client.query(
      'UPDATE harness_steps SET continuation_stack_json = $1, base_scope_checkpoint = $2 WHERE step_exec_id = $3 AND run_id = $4',
      [stackJson, params.baseScopeCheckpoint, params.stepExecId, params.runId],
    );
  } else {
    await client.query(
      'UPDATE harness_steps SET continuation_stack_json = $1 WHERE step_exec_id = $2 AND run_id = $3',
      [stackJson, params.stepExecId, params.runId],
    );
  }
}

/**
 * Records a step lifecycle transition (`'RUNNING' | 'COMPLETED' | 'INTERRUPTED' | 'FAILED' | 'SUSPENDED'`) in PostgreSQL.
 *
 * Updates `harness_steps` and synchronizes `harness_runs.status` when a step suspends or resumes.
 *
 * @param {PostgresQueryClient}       client     - Active PostgreSQL query client.
 * @param {RecordStepTransitionInput} transition - Step transition payload and telemetry snapshot.
 *
 * @returns {Promise<void>} Resolves once the step transition is persisted.
 */
export async function recordStepTransitionInPg(
  client: PostgresQueryClient,
  transition: RecordStepTransitionInput,
): Promise<void> {
  await client.query(
    'UPDATE harness_steps SET status = $1, output_json = COALESCE($2, output_json), base_scope_checkpoint = COALESCE($3, base_scope_checkpoint), head_scope_checkpoint = COALESCE($4, head_scope_checkpoint), telemetry_json = $5 WHERE step_exec_id = $6',
    [transition.status, transition.outputJson ?? null, transition.baseScopeCheckpoint ?? null, transition.headScopeCheckpoint ?? null, transition.telemetryJson, transition.stepExecId],
  );
  const stepRes = await client.query<{ readonly run_id: string }>('SELECT run_id FROM harness_steps WHERE step_exec_id = $1', [transition.stepExecId]);
  const stepRow = stepRes.rows[0];
  if (stepRow !== undefined && (transition.status === 'SUSPENDED' || transition.status === 'RUNNING')) {
    await client.query('UPDATE harness_runs SET status = $1, updated_at = $2 WHERE run_id = $3', [transition.status, new Date().toISOString(), stepRow.run_id]);
  }
}

/**
 * Queries all non-terminal runs (`'QUEUED' | 'RUNNING' | 'WAITING' | 'SUSPENDED'`) on runtime startup from PostgreSQL.
 *
 * Joins each non-terminal run with its latest step attempt and lane dependency list for crash recovery.
 *
 * @param {PostgresQueryClient} client - Active PostgreSQL query client.
 *
 * @returns {Promise<readonly InterruptedStepBootRecord[]>} Non-terminal runs requiring crash recovery.
 */
export async function getInterruptedStepsOnBootFromPg(
  client: PostgresQueryClient,
): Promise<readonly InterruptedStepBootRecord[]> {
  const runRes = await client.query<PgRunRow>("SELECT * FROM harness_runs WHERE status IN ('QUEUED', 'RUNNING', 'WAITING', 'SUSPENDED') ORDER BY created_at ASC");
  const results: InterruptedStepBootRecord[] = [];
  for (const runRow of runRes.rows) {
    const stepRes = await client.query<PgStepRow>('SELECT * FROM harness_steps WHERE run_id = $1 ORDER BY seq DESC LIMIT 1', [runRow.run_id]);
    const stepRow = stepRes.rows[0];
    const laneRes = await client.query<{ readonly depends_on_json: string }>('SELECT depends_on_json FROM harness_lane_items WHERE lane_id = $1 AND item_key = $2', [runRow.lane_id, runRow.item_key]);
    const laneRow = laneRes.rows[0];
    const dependsOn = laneRow !== undefined ? (JSON.parse(laneRow.depends_on_json) as string[]) : [];
    const stack = stepRow !== undefined ? (JSON.parse(stepRow.continuation_stack_json) as ContinuationFrame[]) : [];
    results.push(Object.freeze<InterruptedStepBootRecord>({
      runId: runRow.run_id, laneId: runRow.lane_id, itemKey: runRow.item_key, inputJson: runRow.input_json,
      status: runRow.status as 'QUEUED' | 'RUNNING' | 'WAITING' | 'SUSPENDED', dependsOn: Object.freeze([...dependsOn]),
      stepExecId: stepRow?.step_exec_id ?? null, stepId: stepRow?.step_id ?? runRow.current_step_id,
      executableId: stepRow?.executable_id ?? undefined, baseScopeCheckpoint: stepRow?.base_scope_checkpoint ?? undefined,
      headScopeCheckpoint: stepRow?.head_scope_checkpoint ?? undefined, continuationStack: Object.freeze([...stack]),
    }));
  }
  return Object.freeze(results);
}
