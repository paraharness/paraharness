import type { CommitRunOverlayResult } from '@harness-dsl/core';
import type { PostgresQueryClient } from '../../ddl/postgres-query-client.js';
import type { PgTopologyBaseRow } from './pg-topology-base-row.js';
import type { PgTopologyOverlayRow } from './pg-topology-overlay-row.js';
import { threeWayMergeContract } from './three-way-merge-contract.js';

/**
 * Transitions `runId`'s uncommitted topology overlay rows to `SEALED_UNMERGED` in PostgreSQL.
 *
 * Called when a flow reaches terminal `'done'` while awaiting an external merge signal (`SPEC.md` §3.3).
 *
 * @param {PostgresQueryClient} client - Active PostgreSQL query client.
 * @param {string}              runId  - Completed flow run identifier.
 *
 * @returns {Promise<void>} Resolves once the overlay rows are marked `SEALED_UNMERGED`.
 */
export async function sealPgOverlayForRun(
  client: PostgresQueryClient,
  runId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await client.query(
    "UPDATE harness_topology_overlays SET status = 'SEALED_UNMERGED', updated_at = $1 WHERE run_id = $2",
    [now, runId],
  );
}

/**
 * Atomically commits `runId`'s overlay (and any absorbed `SEALED_UNMERGED` prerequisite overlays)
 * into `harness_topology_base` using a 3-way merge against `base_contract_text_at_acquire` in PostgreSQL.
 *
 * Allocates monotonic base epoch numbers (`currentBase.epoch + 1`) and returns `{ committedRunIds, updatedEpochs }`.
 *
 * @param {PostgresQueryClient} client - Active PostgreSQL query client.
 * @param {string}              runId  - Flow run identifier whose changes landed.
 *
 * @returns {Promise<CommitRunOverlayResult>} Committed run IDs and newly allocated base epochs.
 */
export async function commitPgOverlayThreeWayMerge(
  client: PostgresQueryClient,
  runId: string,
): Promise<CommitRunOverlayResult> {
  const ovRes = await client.query<PgTopologyOverlayRow>(
    'SELECT * FROM harness_topology_overlays WHERE run_id = $1 AND (mutated_in_run = 1 OR has_uncommitted_changes = 1) ORDER BY partition_id ASC',
    [runId],
  );
  const committedRunSet = new Set<string>();
  const updatedEpochs = new Map<string, number>();
  const now = new Date().toISOString();
  for (const ovRow of ovRes.rows) {
    for (const absorbedId of JSON.parse(ovRow.absorbed_run_ids_json) as string[]) {
      committedRunSet.add(absorbedId);
    }
    const baseRes = await client.query<PgTopologyBaseRow>('SELECT * FROM harness_topology_base WHERE partition_id = $1', [ovRow.partition_id]);
    const baseRow = baseRes.rows[0];
    const currentBaseText = baseRow?.contract_text ?? '';
    const currentBaseEpoch = baseRow?.epoch ?? 0;
    const mergeBaseText = currentBaseText === ovRow.initial_base_contract_text ? ovRow.initial_base_contract_text : ovRow.base_contract_text_at_acquire;
    const mergedText = threeWayMergeContract(mergeBaseText, currentBaseText, ovRow.contract_text);
    if (baseRow === undefined || mergedText !== currentBaseText || ovRow.mutated_in_run === 1) {
      const nextBaseEpoch = currentBaseEpoch + 1;
      const mutatorRunId = ovRow.last_mutated_by_run_id ?? runId;
      await client.query(
        'INSERT INTO harness_topology_base (partition_id, epoch, contract_text, updated_at, last_mutated_by_run_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (partition_id) DO UPDATE SET epoch = EXCLUDED.epoch, contract_text = EXCLUDED.contract_text, updated_at = EXCLUDED.updated_at, last_mutated_by_run_id = EXCLUDED.last_mutated_by_run_id',
        [ovRow.partition_id, nextBaseEpoch, mergedText, now, mutatorRunId],
      );
      updatedEpochs.set(ovRow.partition_id, nextBaseEpoch);
    }
  }
  committedRunSet.add(runId);
  const committedRunIds = Array.from(committedRunSet);
  for (const committedId of committedRunIds) {
    await client.query('DELETE FROM harness_topology_overlays WHERE run_id = $1', [committedId]);
  }
  return Object.freeze<CommitRunOverlayResult>({ committedRunIds: Object.freeze(committedRunIds), updatedEpochs });
}

/**
 * Discards all overlay rows for `runId` without mutating `harness_topology_base` in PostgreSQL.
 *
 * Invoked when a run fails, a PR closes unmerged, or `maxSealedAgeHours` expires (`SPEC.md` §3.3).
 *
 * @param {PostgresQueryClient} client - Active PostgreSQL query client.
 * @param {string}              runId  - Flow run identifier whose overlay should be discarded.
 *
 * @returns {Promise<void>} Resolves once the overlay rows are deleted.
 */
export async function discardPgOverlayForRun(
  client: PostgresQueryClient,
  runId: string,
): Promise<void> {
  await client.query('DELETE FROM harness_topology_overlays WHERE run_id = $1', [runId]);
}
