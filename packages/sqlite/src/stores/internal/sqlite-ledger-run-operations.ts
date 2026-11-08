import type { CreateOrResumeRunInput, CreateOrResumeRunResult } from '@metaharness/core';
import type Database from 'better-sqlite3';
import type { SqliteRunRow } from './sqlite-run-row.js';

/**
 * Loads completed step outputs (`stepId -> outputJson`) for `runId` from `harness_step_executions`.
 *
 * Queries completed step executions in ascending `seq_id` order so the latest completed execution
 * of each `stepId` populates the returned map without dynamic `Object.entries` allocations.
 *
 * @param {Database.Database} db    - Active SQLite database handle.
 * @param {string}            runId - Enclosing flow run identifier.
 *
 * @returns {Map<string, string>} Map of completed `stepId` to serialized `outputJson`.
 */
export function loadCompletedStepOutputsFromSqlite(
  db: Database.Database,
  runId: string,
): Map<string, string> {
  const rows = db
    .prepare(
      "SELECT step_id, output_json FROM harness_step_executions WHERE run_id = ? AND status = 'COMPLETED' ORDER BY seq_id ASC",
    )
    .all(runId) as ReadonlyArray<{
    readonly step_id: string;
    readonly output_json: string | null;
  }>;
  const completedOutputs = new Map<string, string>();
  for (const row of rows) {
    if (row.output_json !== null) {
      completedOutputs.set(row.step_id, row.output_json);
    }
  }
  return completedOutputs;
}

/**
 * Inserts a newly initialized flow run row (`status: 'RUNNING'`) and ensures its lane item exists.
 *
 * Replaces any stale `'QUEUED'` placeholder run for the same `(laneId, itemKey)` and pins
 * `compiledPrefixesJson` at run creation time (`SPEC.md` §2.7).
 *
 * @param {Database.Database}      db  - Active SQLite database handle.
 * @param {CreateOrResumeRunInput} run - Run initialization request payload.
 * @param {string}                 now - ISO-8601 timestamp string for `updated_at`.
 *
 * @returns {CreateOrResumeRunResult} Newly initialized run state with empty completed step outputs.
 */
export function insertInitialSqliteRun(
  db: Database.Database,
  run: CreateOrResumeRunInput,
  now: string,
): CreateOrResumeRunResult {
  const laneItem = db
    .prepare('SELECT depends_on_json FROM harness_lane_items WHERE lane_id = ? AND item_key = ?')
    .get(run.laneId, run.itemKey) as { readonly depends_on_json: string } | undefined;
  const depsJson = laneItem?.depends_on_json ?? '[]';
  const prefixesJson =
    run.compiledPrefixesJson !== undefined ? JSON.stringify(run.compiledPrefixesJson) : null;
  db.prepare(
    "DELETE FROM harness_runs WHERE lane_id = ? AND item_key = ? AND status = 'QUEUED' AND run_id != ?",
  ).run(run.laneId, run.itemKey, run.runId);
  db.prepare(
    "INSERT INTO harness_runs (run_id, lane_id, item_key, status, current_step_id, input_json, rewind_pending_to_step_id, compiled_prefixes_json, cost_usd, approved_max_cost_usd, completed_step_outputs_json, depends_on_json, updated_at) VALUES (?, ?, ?, 'RUNNING', NULL, ?, NULL, ?, ?, ?, '{}', ?, ?)",
  ).run(
    run.runId,
    run.laneId,
    run.itemKey,
    run.inputJson,
    prefixesJson,
    run.costUsd ?? 0,
    run.approvedMaxCostUsd ?? null,
    depsJson,
    now,
  );
  db.prepare(
    "INSERT OR IGNORE INTO harness_lane_items (lane_id, item_key, input_json, depends_on_json, priority) VALUES (?, ?, ?, ?, 'normal')",
  ).run(run.laneId, run.itemKey, run.inputJson, depsJson);
  const pinned =
    prefixesJson !== null
      ? Object.freeze(JSON.parse(prefixesJson) as Record<string, string>)
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
 * Resumes an existing flow run row in `harness_runs`, preserving its pinned `compiled_prefixes_json`.
 *
 * Updates `cost_usd` and `approved_max_cost_usd` if provided and loads completed step outputs.
 *
 * @param {Database.Database}      db       - Active SQLite database handle.
 * @param {SqliteRunRow}           existing - Existing persisted run row.
 * @param {CreateOrResumeRunInput} run      - Resume request payload.
 *
 * @returns {CreateOrResumeRunResult} Resumed run state and completed step outputs.
 */
export function resumeExistingSqliteRun(
  db: Database.Database,
  existing: SqliteRunRow,
  run: CreateOrResumeRunInput,
): CreateOrResumeRunResult {
  const nextCostUsd = run.costUsd ?? existing.cost_usd;
  const nextApprovedMax = run.approvedMaxCostUsd ?? existing.approved_max_cost_usd ?? undefined;
  const now = new Date().toISOString();
  db.prepare(
    'UPDATE harness_runs SET cost_usd = ?, approved_max_cost_usd = ?, updated_at = ? WHERE run_id = ?',
  ).run(nextCostUsd, nextApprovedMax ?? null, now, run.runId);
  const pinned =
    existing.compiled_prefixes_json !== null
      ? Object.freeze(JSON.parse(existing.compiled_prefixes_json) as Record<string, string>)
      : undefined;
  return Object.freeze<CreateOrResumeRunResult>({
    status: existing.status,
    currentStepId: existing.current_step_id,
    inputJson: existing.input_json,
    rewindPendingToStepId: existing.rewind_pending_to_step_id ?? undefined,
    compiledPrefixesJson: pinned,
    costUsd: nextCostUsd,
    approvedMaxCostUsd: nextApprovedMax,
    completedStepOutputsJson: loadCompletedStepOutputsFromSqlite(db, run.runId),
  });
}
