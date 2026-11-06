import type {
  CreateOrResumeRunInput,
  CreateOrResumeRunResult,
  RunTerminalReceiptRecord,
} from '@harness-dsl/core';
import type Database from 'better-sqlite3';
import type { RecordTerminalReceiptParams } from './record-terminal-receipt-params.js';
import type { SqliteRunRow } from './sqlite-run-row.js';

/**
 * Inserts a new flow run row (`status: 'RUNNING'`) or returns the existing run's persisted state.
 *
 * Pins `compiledPrefixesJson` at initial run creation so subsequent resume calls never overwrite it.
 *
 * @param {Database.Database}      db  - Active SQLite database handle.
 * @param {CreateOrResumeRunInput} run - Run initialization or resume request payload.
 *
 * @returns {CreateOrResumeRunResult} Persisted run status, pinned prefixes, and completed step outputs.
 */
export function createOrResumeRunInSqlite(
  db: Database.Database,
  run: CreateOrResumeRunInput,
): CreateOrResumeRunResult {
  const existing = db.prepare('SELECT * FROM harness_runs WHERE run_id = ?').get(run.runId) as SqliteRunRow | undefined;
  const now = new Date().toISOString();
  if (existing === undefined) {
    const laneItem = db.prepare('SELECT depends_on_json FROM harness_lane_items WHERE lane_id = ? AND item_key = ?').get(run.laneId, run.itemKey) as { readonly depends_on_json: string } | undefined;
    const depsJson = laneItem?.depends_on_json ?? '[]';
    const prefixesJson = run.compiledPrefixesJson !== undefined ? JSON.stringify(run.compiledPrefixesJson) : null;
    db.prepare("DELETE FROM harness_runs WHERE lane_id = ? AND item_key = ? AND status = 'QUEUED' AND run_id != ?").run(run.laneId, run.itemKey, run.runId);
    db.prepare('INSERT INTO harness_runs (run_id, lane_id, item_key, status, current_step_id, input_json, rewind_pending_to_step_id, compiled_prefixes_json, cost_usd, approved_max_cost_usd, completed_step_outputs_json, depends_on_json, updated_at) VALUES (?, ?, ?, \'RUNNING\', NULL, ?, NULL, ?, ?, ?, \'{}\', ?, ?)').run(run.runId, run.laneId, run.itemKey, run.inputJson, prefixesJson, run.costUsd ?? 0, run.approvedMaxCostUsd ?? null, depsJson, now);
    db.prepare("INSERT OR IGNORE INTO harness_lane_items (lane_id, item_key, input_json, depends_on_json, priority) VALUES (?, ?, ?, ?, 'normal')").run(run.laneId, run.itemKey, run.inputJson, depsJson);
    const pinned = run.compiledPrefixesJson !== undefined ? Object.freeze({ ...run.compiledPrefixesJson }) : undefined;
    return Object.freeze<CreateOrResumeRunResult>({
      status: 'RUNNING', currentStepId: null, inputJson: run.inputJson, rewindPendingToStepId: undefined,
      compiledPrefixesJson: pinned, costUsd: run.costUsd ?? 0, approvedMaxCostUsd: run.approvedMaxCostUsd,
      completedStepOutputsJson: new Map<string, string>(),
    });
  }
  const nextCostUsd = run.costUsd ?? existing.cost_usd;
  const nextApprovedMax = run.approvedMaxCostUsd ?? existing.approved_max_cost_usd ?? undefined;
  db.prepare('UPDATE harness_runs SET cost_usd = ?, approved_max_cost_usd = ?, updated_at = ? WHERE run_id = ?').run(nextCostUsd, nextApprovedMax ?? null, now, run.runId);
  const rawOutputs = JSON.parse(existing.completed_step_outputs_json) as Record<string, string>;
  const pinned = existing.compiled_prefixes_json !== null ? Object.freeze(JSON.parse(existing.compiled_prefixes_json) as Record<string, string>) : undefined;
  return Object.freeze<CreateOrResumeRunResult>({
    status: existing.status, currentStepId: existing.current_step_id, inputJson: existing.input_json,
    rewindPendingToStepId: existing.rewind_pending_to_step_id ?? undefined, compiledPrefixesJson: pinned,
    costUsd: nextCostUsd, approvedMaxCostUsd: nextApprovedMax,
    completedStepOutputsJson: new Map<string, string>(Object.entries(rawOutputs)),
  });
}

/**
 * Updates `input_json` and optional `rewind_pending_to_step_id` for `runId` in `harness_runs`.
 *
 * Used during `.replaceWith()` step promotion and `.onSignal().rewindTo()` transitions.
 *
 * @param {Database.Database}                                                              db     - Active SQLite database handle.
 * @param {string}                                                                         runId  - Target flow run identifier.
 * @param {{ readonly inputJson: string; readonly rewindPendingToStepId?: string | null }} update - Updated input JSON and rewind target.
 *
 * @returns {void} Returns nothing once the update is committed.
 */
export function updateRunInputInSqlite(
  db: Database.Database,
  runId: string,
  update: { readonly inputJson: string; readonly rewindPendingToStepId?: string | null },
): void {
  const now = new Date().toISOString();
  if (update.rewindPendingToStepId !== undefined) {
    db.prepare('UPDATE harness_runs SET input_json = ?, rewind_pending_to_step_id = ?, updated_at = ? WHERE run_id = ?').run(update.inputJson, update.rewindPendingToStepId, now, runId);
    return;
  }
  db.prepare('UPDATE harness_runs SET input_json = ?, updated_at = ? WHERE run_id = ?').run(update.inputJson, now, runId);
}

/**
 * Persists a terminal run receipt in `harness_terminal_receipts` and marks the run terminal in `harness_runs`.
 *
 * Enables dependent runs to inspect prerequisite terminal receipts during `syncRoot` wakeup.
 *
 * @param {Database.Database}           db     - Active SQLite database handle.
 * @param {RecordTerminalReceiptParams} params - Terminal receipt parameters.
 *
 * @returns {void} Returns nothing once the receipt is persisted.
 */
export function recordRunTerminalReceiptInSqlite(
  db: Database.Database,
  params: RecordTerminalReceiptParams,
): void {
  const now = new Date().toISOString();
  db.prepare('INSERT OR REPLACE INTO harness_terminal_receipts (item_key, run_id, terminal_state, scope_receipt_json, recorded_at) VALUES (?, ?, ?, ?, ?)').run(params.itemKey, params.runId, params.terminalState, params.scopeReceiptJson ?? null, now);
  db.prepare('UPDATE harness_runs SET status = ?, terminal_state = ?, scope_receipt_json = ?, updated_at = ? WHERE run_id = ?').run(params.terminalState, params.terminalState, params.scopeReceiptJson ?? null, now, params.runId);
}

/**
 * Queries terminal run receipts keyed by `itemKey` from `harness_terminal_receipts`.
 *
 * Returns a map of `itemKey -> RunTerminalReceiptRecord` for all matching items.
 *
 * @param {Database.Database} db       - Active SQLite database handle.
 * @param {readonly string[]} itemKeys - Work item keys to look up.
 *
 * @returns {ReadonlyMap<string, RunTerminalReceiptRecord>} Map of `itemKey` to terminal receipt record.
 */
export function getRunTerminalReceiptsFromSqlite(
  db: Database.Database,
  itemKeys: readonly string[],
): ReadonlyMap<string, RunTerminalReceiptRecord> {
  const receipts = new Map<string, RunTerminalReceiptRecord>();
  const stmt = db.prepare('SELECT item_key, run_id, terminal_state, scope_receipt_json FROM harness_terminal_receipts WHERE item_key = ?');
  for (const itemKey of itemKeys) {
    const row = stmt.get(itemKey) as { readonly item_key: string; readonly run_id: string; readonly terminal_state: string; readonly scope_receipt_json: string | null } | undefined;
    if (row !== undefined) {
      receipts.set(row.item_key, Object.freeze<RunTerminalReceiptRecord>({
        runId: row.run_id, terminalState: row.terminal_state, scopeReceiptJson: row.scope_receipt_json ?? undefined,
      }));
    }
  }
  return receipts;
}
