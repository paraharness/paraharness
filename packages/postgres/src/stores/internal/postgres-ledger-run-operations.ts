import type { CreateOrResumeRunInput, CreateOrResumeRunResult } from '@harness-dsl/core';
import type { PostgresQueryClient } from '../../ddl/postgres-query-client.js';
import type { PgRunRow } from './pg-run-row.js';
import type { PgStepRow } from './pg-step-row.js';

/**
 * Loads completed step outputs (`stepId -> outputJson`) for `runId` from `harness_steps` in PostgreSQL.
 *
 * Queries completed step executions in ascending `seq` order so the latest completed execution
 * of each `stepId` populates the returned map.
 *
 * @param {PostgresQueryClient} client - Active PostgreSQL query client.
 * @param {string}              runId  - Enclosing flow run identifier.
 *
 * @returns {Promise<Map<string, string>>} Map of completed `stepId` to serialized `outputJson`.
 */
export async function loadCompletedStepOutputsFromPg(
  client: PostgresQueryClient,
  runId: string,
): Promise<Map<string, string>> {
  const stepQueryResult = await client.query<Pick<PgStepRow, 'step_id' | 'output_json'>>(
    "SELECT step_id, output_json FROM harness_steps WHERE run_id = $1 AND status = 'COMPLETED' ORDER BY seq ASC",
    [runId],
  );
  const completedOutputs = new Map<string, string>();
  for (const row of stepQueryResult.rows) {
    if (row.output_json !== null) {
      completedOutputs.set(row.step_id, row.output_json);
    }
  }
  return completedOutputs;
}

/**
 * Inserts a newly initialized flow run row (`status: 'RUNNING'`) and ensures its lane item exists in PostgreSQL.
 *
 * Replaces any stale `'QUEUED'` placeholder run for the same `(laneId, itemKey)` and pins
 * `compiledPrefixesJson` at run creation time (`SPEC.md` §2.7).
 *
 * @param {PostgresQueryClient}    client - Active PostgreSQL query client.
 * @param {CreateOrResumeRunInput} run    - Run initialization request payload.
 * @param {string}                 now    - ISO-8601 timestamp string for `created_at` and `updated_at`.
 *
 * @returns {Promise<CreateOrResumeRunResult>} Newly initialized run state with empty completed step outputs.
 */
export async function insertInitialPgRun(
  client: PostgresQueryClient,
  run: CreateOrResumeRunInput,
  now: string,
): Promise<CreateOrResumeRunResult> {
  const prefixesStr =
    run.compiledPrefixesJson !== undefined ? JSON.stringify(run.compiledPrefixesJson) : null;
  await client.query(
    "DELETE FROM harness_runs WHERE lane_id = $1 AND item_key = $2 AND status = 'QUEUED' AND run_id != $3",
    [run.laneId, run.itemKey, run.runId],
  );
  await client.query(
    'INSERT INTO harness_runs (run_id, lane_id, item_key, status, current_step_id, input_json, rewind_pending_to_step_id, compiled_prefixes_json, cost_usd, approved_max_cost_usd, terminal_state, scope_receipt_json, created_at, updated_at) VALUES ($1, $2, $3, $4, NULL, $5, NULL, $6, $7, $8, NULL, NULL, $9, $10)',
    [
      run.runId,
      run.laneId,
      run.itemKey,
      'RUNNING',
      run.inputJson,
      prefixesStr,
      run.costUsd ?? 0,
      run.approvedMaxCostUsd ?? null,
      now,
      now,
    ],
  );
  await client.query(
    "INSERT INTO harness_lane_items (lane_id, item_key, input_json, priority, depends_on_json, latest_spawned_tip_key) VALUES ($1, $2, $3, 'normal', '[]', NULL) ON CONFLICT (lane_id, item_key) DO NOTHING",
    [run.laneId, run.itemKey, run.inputJson],
  );
  const pinned =
    prefixesStr !== null
      ? Object.freeze(JSON.parse(prefixesStr) as Record<string, string>)
      : undefined;
  return Object.freeze<CreateOrResumeRunResult>({
    status: 'RUNNING',
    currentStepId: null,
    inputJson: run.inputJson,
    rewindPendingToStepId: undefined,
    compiledPrefixesJson: pinned,
    costUsd: run.costUsd ?? 0,
    approvedMaxCostUsd: run.approvedMaxCostUsd,
    completedStepOutputsJson: new Map<string, string>(),
  });
}

/**
 * Resumes an existing flow run row in `harness_runs` in PostgreSQL, preserving its pinned `compiled_prefixes_json`.
 *
 * Updates `cost_usd` and `approved_max_cost_usd` if provided and loads completed step outputs.
 *
 * @param {PostgresQueryClient}    client   - Active PostgreSQL query client.
 * @param {PgRunRow}               existing - Existing persisted run row.
 * @param {CreateOrResumeRunInput} run      - Resume request payload.
 *
 * @returns {Promise<CreateOrResumeRunResult>} Resumed run state and completed step outputs.
 */
export async function resumeExistingPgRun(
  client: PostgresQueryClient,
  existing: PgRunRow,
  run: CreateOrResumeRunInput,
): Promise<CreateOrResumeRunResult> {
  const nextCost = run.costUsd !== undefined ? run.costUsd : existing.cost_usd;
  const nextApproved =
    run.approvedMaxCostUsd !== undefined
      ? run.approvedMaxCostUsd
      : (existing.approved_max_cost_usd ?? undefined);
  const now = new Date().toISOString();
  await client.query(
    'UPDATE harness_runs SET cost_usd = $1, approved_max_cost_usd = $2, updated_at = $3 WHERE run_id = $4',
    [nextCost, nextApproved ?? null, now, run.runId],
  );
  const completedOutputs = await loadCompletedStepOutputsFromPg(client, run.runId);
  const pinnedPrefixes =
    existing.compiled_prefixes_json !== null
      ? Object.freeze(JSON.parse(existing.compiled_prefixes_json) as Record<string, string>)
      : undefined;
  return Object.freeze<CreateOrResumeRunResult>({
    status: existing.status,
    currentStepId: existing.current_step_id,
    inputJson: existing.input_json,
    rewindPendingToStepId: existing.rewind_pending_to_step_id ?? undefined,
    compiledPrefixesJson: pinnedPrefixes,
    costUsd: nextCost,
    approvedMaxCostUsd: nextApproved,
    completedStepOutputsJson: completedOutputs,
  });
}
