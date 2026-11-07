import type {
  CreateOrResumeRunInput,
  CreateOrResumeRunResult,
  RunTerminalReceiptRecord,
} from '@harness-dsl/core';
import type { PostgresQueryClient } from '../../ddl/postgres-query-client.js';
import type { PgRunRow } from './pg-run-row.js';
import {
  insertInitialPgRun,
  resumeExistingPgRun,
} from './postgres-ledger-run-operations.js';
import type { RecordTerminalReceiptParams } from './record-terminal-receipt-params.js';

/**
 * Parameters for updating a run's serialized flow input payload and optional pending rewind target step ID in PostgreSQL.
 */
export interface UpdatePgRunInputParams {
  /** Serialized JSON flow input payload. */
  readonly inputJson: string;
  /** Optional target step ID when a rewind is pending, or `null` to clear. */
  readonly rewindPendingToStepId?: string | null;
}

/**
 * Creates a new flow run row (`status: 'RUNNING'`) or resumes an existing run in PostgreSQL.
 *
 * Pins `compiledPrefixesJson` at initial run start so subsequent resumes never overwrite it,
 * and reconstructs `completedStepOutputsJson` from completed `harness_steps` rows.
 *
 * @param {PostgresQueryClient}    client - Active PostgreSQL query client.
 * @param {CreateOrResumeRunInput} run    - Run initialization or resume request payload.
 *
 * @returns {Promise<CreateOrResumeRunResult>} Current persisted state and completed step outputs.
 */
export async function createOrResumeRunInPg(
  client: PostgresQueryClient,
  run: CreateOrResumeRunInput,
): Promise<CreateOrResumeRunResult> {
  const existingQueryResult = await client.query<PgRunRow>(
    'SELECT * FROM harness_runs WHERE run_id = $1',
    [run.runId],
  );
  const existing = existingQueryResult.rows[0];
  if (existing === undefined) {
    return insertInitialPgRun(client, run, new Date().toISOString());
  }
  return resumeExistingPgRun(client, existing, run);
}

/**
 * Updates a run's serialized flow input payload and optional pending rewind target step ID in PostgreSQL.
 *
 * Used during `.replaceWith()` step promotion and `.onSignal().rewindTo()` transitions.
 *
 * @param {PostgresQueryClient}    client - Active PostgreSQL query client.
 * @param {string}                 runId  - Target flow run identifier.
 * @param {UpdatePgRunInputParams} update - Updated input JSON and rewind target.
 *
 * @returns {Promise<void>} Resolves once the update statement completes.
 */
export async function updateRunInputInPg(
  client: PostgresQueryClient,
  runId: string,
  update: UpdatePgRunInputParams,
): Promise<void> {
  const now = new Date().toISOString();
  if (update.rewindPendingToStepId !== undefined) {
    await client.query(
      'UPDATE harness_runs SET input_json = $1, rewind_pending_to_step_id = $2, updated_at = $3 WHERE run_id = $4',
      [update.inputJson, update.rewindPendingToStepId, now, runId],
    );
    return;
  }
  await client.query(
    'UPDATE harness_runs SET input_json = $1, updated_at = $2 WHERE run_id = $3',
    [update.inputJson, now, runId],
  );
}

/**
 * Persists the terminal exit state and final scope receipt for `params.runId` and `params.itemKey` in PostgreSQL.
 *
 * Updates both `harness_runs` and `harness_terminal_receipts` so dependent runs can inspect prerequisite receipts.
 *
 * @param {PostgresQueryClient}         client - Active PostgreSQL query client.
 * @param {RecordTerminalReceiptParams} params - Terminal receipt parameters.
 *
 * @returns {Promise<void>} Resolves once the terminal receipt is committed.
 */
export async function recordRunTerminalReceiptInPg(
  client: PostgresQueryClient,
  params: RecordTerminalReceiptParams,
): Promise<void> {
  const now = new Date().toISOString();
  await client.query(
    'UPDATE harness_runs SET status = $1, terminal_state = $2, scope_receipt_json = $3, updated_at = $4 WHERE run_id = $5',
    [
      params.terminalState,
      params.terminalState,
      params.scopeReceiptJson ?? null,
      now,
      params.runId,
    ],
  );
  await client.query(
    'INSERT INTO harness_terminal_receipts (item_key, run_id, terminal_state, scope_receipt_json, updated_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (item_key) DO UPDATE SET run_id = EXCLUDED.run_id, terminal_state = EXCLUDED.terminal_state, scope_receipt_json = EXCLUDED.scope_receipt_json, updated_at = EXCLUDED.updated_at',
    [params.itemKey, params.runId, params.terminalState, params.scopeReceiptJson ?? null, now],
  );
}

/**
 * Retrieves the latest terminal run receipts keyed by `itemKey` from PostgreSQL.
 *
 * Used by the scheduler and prerequisite barrier to verify prerequisite completion and gather scope receipts.
 *
 * @param {PostgresQueryClient} client   - Active PostgreSQL query client.
 * @param {readonly string[]}   itemKeys - Work item keys to query.
 *
 * @returns {Promise<ReadonlyMap<string, RunTerminalReceiptRecord>>} Map of `itemKey` to terminal receipt record.
 */
export async function getRunTerminalReceiptsFromPg(
  client: PostgresQueryClient,
  itemKeys: readonly string[],
): Promise<ReadonlyMap<string, RunTerminalReceiptRecord>> {
  const receipts = new Map<string, RunTerminalReceiptRecord>();
  for (const itemKey of itemKeys) {
    const queryResult = await client.query<{
      readonly item_key: string;
      readonly run_id: string;
      readonly terminal_state: string;
      readonly scope_receipt_json: string | null;
    }>(
      'SELECT item_key, run_id, terminal_state, scope_receipt_json FROM harness_terminal_receipts WHERE item_key = $1',
      [itemKey],
    );
    const row = queryResult.rows[0];
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
