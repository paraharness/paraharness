import type { CreateOrResumeRunInput, CreateOrResumeRunResult, RunTerminalReceiptRecord } from '@harness-dsl/core';
import type { PostgresQueryClient } from '../../ddl/postgres-query-client.js';
import type { PgRunRow } from './pg-run-row.js';
import type { PgStepRow } from './pg-step-row.js';
import type { RecordTerminalReceiptParams } from './record-terminal-receipt-params.js';

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
  const existingRes = await client.query<PgRunRow>('SELECT * FROM harness_runs WHERE run_id = $1', [run.runId]);
  const existing = existingRes.rows[0];
  const now = new Date().toISOString();
  if (existing === undefined) {
    const prefixesStr = run.compiledPrefixesJson !== undefined ? JSON.stringify(run.compiledPrefixesJson) : null;
    await client.query(
      'INSERT INTO harness_runs (run_id, lane_id, item_key, status, current_step_id, input_json, rewind_pending_to_step_id, compiled_prefixes_json, cost_usd, approved_max_cost_usd, terminal_state, scope_receipt_json, created_at, updated_at) VALUES ($1, $2, $3, $4, NULL, $5, NULL, $6, $7, $8, NULL, NULL, $9, $10)',
      [run.runId, run.laneId, run.itemKey, 'RUNNING', run.inputJson, prefixesStr, run.costUsd ?? 0, run.approvedMaxCostUsd ?? null, now, now],
    );
    return Object.freeze<CreateOrResumeRunResult>({
      status: 'RUNNING', currentStepId: null, inputJson: run.inputJson, rewindPendingToStepId: undefined,
      compiledPrefixesJson: run.compiledPrefixesJson ? Object.freeze({ ...run.compiledPrefixesJson }) : undefined,
      costUsd: run.costUsd ?? 0, approvedMaxCostUsd: run.approvedMaxCostUsd, completedStepOutputsJson: new Map<string, string>(),
    });
  }
  const nextCost = run.costUsd !== undefined ? run.costUsd : existing.cost_usd;
  const nextApproved = run.approvedMaxCostUsd !== undefined ? run.approvedMaxCostUsd : (existing.approved_max_cost_usd ?? undefined);
  await client.query('UPDATE harness_runs SET cost_usd = $1, approved_max_cost_usd = $2, updated_at = $3 WHERE run_id = $4', [nextCost, nextApproved ?? null, now, run.runId]);
  const stepRes = await client.query<Pick<PgStepRow, 'step_id' | 'output_json'>>("SELECT step_id, output_json FROM harness_steps WHERE run_id = $1 AND status = 'COMPLETED' ORDER BY seq ASC", [run.runId]);
  const completedOutputs = new Map<string, string>();
  for (const row of stepRes.rows) {
    if (row.output_json !== null) completedOutputs.set(row.step_id, row.output_json);
  }
  const pinnedPrefixes = existing.compiled_prefixes_json !== null ? Object.freeze(JSON.parse(existing.compiled_prefixes_json) as Record<string, string>) : undefined;
  return Object.freeze<CreateOrResumeRunResult>({
    status: existing.status, currentStepId: existing.current_step_id, inputJson: existing.input_json,
    rewindPendingToStepId: existing.rewind_pending_to_step_id ?? undefined, compiledPrefixesJson: pinnedPrefixes,
    costUsd: nextCost, approvedMaxCostUsd: nextApproved, completedStepOutputsJson: completedOutputs,
  });
}

/**
 * Updates a run's serialized flow input payload and optional pending rewind target step ID in PostgreSQL.
 *
 * Used during `.replaceWith()` step promotion and `.onSignal().rewindTo()` transitions.
 *
 * @param {PostgresQueryClient}                                                            client - Active PostgreSQL query client.
 * @param {string}                                                                         runId  - Target flow run identifier.
 * @param {{ readonly inputJson: string; readonly rewindPendingToStepId?: string | null }} update - Updated input JSON and rewind target.
 *
 * @returns {Promise<void>} Resolves once the update statement completes.
 */
export async function updateRunInputInPg(
  client: PostgresQueryClient,
  runId: string,
  update: { readonly inputJson: string; readonly rewindPendingToStepId?: string | null },
): Promise<void> {
  const now = new Date().toISOString();
  if (update.rewindPendingToStepId !== undefined) {
    await client.query(
      'UPDATE harness_runs SET input_json = $1, rewind_pending_to_step_id = $2, updated_at = $3 WHERE run_id = $4',
      [update.inputJson, update.rewindPendingToStepId, now, runId],
    );
  } else {
    await client.query(
      'UPDATE harness_runs SET input_json = $1, updated_at = $2 WHERE run_id = $3',
      [update.inputJson, now, runId],
    );
  }
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
    [params.terminalState, params.terminalState, params.scopeReceiptJson ?? null, now, params.runId],
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
    const res = await client.query<{ readonly item_key: string; readonly run_id: string; readonly terminal_state: string; readonly scope_receipt_json: string | null }>(
      'SELECT item_key, run_id, terminal_state, scope_receipt_json FROM harness_terminal_receipts WHERE item_key = $1',
      [itemKey],
    );
    const row = res.rows[0];
    if (row !== undefined) {
      receipts.set(row.item_key, Object.freeze<RunTerminalReceiptRecord>({
        runId: row.run_id, terminalState: row.terminal_state, scopeReceiptJson: row.scope_receipt_json ?? undefined,
      }));
    }
  }
  return receipts;
}
