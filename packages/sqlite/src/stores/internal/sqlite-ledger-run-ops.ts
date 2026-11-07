import type {
  CreateOrResumeRunInput,
  CreateOrResumeRunResult,
  RunTerminalReceiptRecord,
} from '@harness-dsl/core';
import type Database from 'better-sqlite3';
import type { RecordTerminalReceiptParams } from './record-terminal-receipt-params.js';
import {
  insertInitialSqliteRun,
  resumeExistingSqliteRun,
} from './sqlite-ledger-run-operations.js';
import type { SqliteRunRow } from './sqlite-run-row.js';

/**
 * Parameters for updating a run's serialized flow input payload and optional pending rewind target step ID.
 */
export interface UpdateRunInputParams {
  /** Serialized JSON flow input payload. */
  readonly inputJson: string;
  /** Optional target step ID when a rewind is pending, or `null` to clear. */
  readonly rewindPendingToStepId?: string | null;
}

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
  const existing = db
    .prepare('SELECT * FROM harness_runs WHERE run_id = ?')
    .get(run.runId) as SqliteRunRow | undefined;
  if (existing === undefined) {
    return insertInitialSqliteRun(db, run, new Date().toISOString());
  }
  return resumeExistingSqliteRun(db, existing, run);
}

/**
 * Updates `input_json` and optional `rewind_pending_to_step_id` for `runId` in `harness_runs`.
 *
 * Used during `.replaceWith()` step promotion and `.onSignal().rewindTo()` transitions.
 *
 * @param {Database.Database}    db     - Active SQLite database handle.
 * @param {string}               runId  - Target flow run identifier.
 * @param {UpdateRunInputParams} update - Updated input JSON and rewind target.
 *
 * @returns {void} Returns nothing once the update is committed.
 */
export function updateRunInputInSqlite(
  db: Database.Database,
  runId: string,
  update: UpdateRunInputParams,
): void {
  const now = new Date().toISOString();
  if (update.rewindPendingToStepId !== undefined) {
    db.prepare(
      'UPDATE harness_runs SET input_json = ?, rewind_pending_to_step_id = ?, updated_at = ? WHERE run_id = ?',
    ).run(update.inputJson, update.rewindPendingToStepId, now, runId);
    return;
  }
  db.prepare('UPDATE harness_runs SET input_json = ?, updated_at = ? WHERE run_id = ?').run(
    update.inputJson,
    now,
    runId,
  );
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
  db.prepare(
    'INSERT OR REPLACE INTO harness_terminal_receipts (item_key, run_id, terminal_state, scope_receipt_json, recorded_at) VALUES (?, ?, ?, ?, ?)',
  ).run(
    params.itemKey,
    params.runId,
    params.terminalState,
    params.scopeReceiptJson ?? null,
    now,
  );
  db.prepare(
    'UPDATE harness_runs SET status = ?, terminal_state = ?, scope_receipt_json = ?, updated_at = ? WHERE run_id = ?',
  ).run(
    params.terminalState,
    params.terminalState,
    params.scopeReceiptJson ?? null,
    now,
    params.runId,
  );
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
  const stmt = db.prepare(
    'SELECT item_key, run_id, terminal_state, scope_receipt_json FROM harness_terminal_receipts WHERE item_key = ?',
  );
  for (const itemKey of itemKeys) {
    const row = stmt.get(itemKey) as
      | {
          readonly item_key: string;
          readonly run_id: string;
          readonly terminal_state: string;
          readonly scope_receipt_json: string | null;
        }
      | undefined;
    if (row !== undefined) {
      receipts.set(
        row.item_key,
        Object.freeze<RunTerminalReceiptRecord>({
          runId: row.run_id,
          terminalState: row.terminal_state,
          scopeReceiptJson: row.scope_receipt_json ?? undefined,
        }),
      );
    }
  }
  return receipts;
}
