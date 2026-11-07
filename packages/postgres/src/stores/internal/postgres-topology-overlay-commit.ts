import type { PostgresQueryClient } from '../../ddl/postgres-query-client.js';
import type { PgTopologyBaseRow } from './pg-topology-base-row.js';
import type { PgTopologyOverlayRow } from './pg-topology-overlay-row.js';
import { threeWayMergeContract } from './three-way-merge-contract.js';

/**
 * Collects all run IDs (`runId` plus any absorbed `SEALED_UNMERGED` prerequisite run IDs)
 * whose overlays are being committed together in a single PostgreSQL `commitRunOverlay` transaction.
 *
 * @param {PostgresQueryClient}             client      - Active PostgreSQL query client.
 * @param {string}                          runId       - Primary committing flow run identifier.
 * @param {readonly PgTopologyOverlayRow[]} overlayRows - Modified overlay rows for `runId`.
 *
 * @returns {Promise<readonly string[]>} Frozen list of committed run identifiers.
 */
export async function collectCommittedPgRunIds(
  client: PostgresQueryClient,
  runId: string,
  overlayRows: readonly PgTopologyOverlayRow[],
): Promise<readonly string[]> {
  const committedRunSet = new Set<string>();
  for (const ovRow of overlayRows) {
    const absorbedIds = JSON.parse(ovRow.absorbed_run_ids_json) as string[];
    for (const absorbedId of absorbedIds) {
      const sealedQueryResult = await client.query<{ readonly found: number }>(
        "SELECT 1 AS found FROM harness_topology_overlays WHERE run_id = $1 AND status = 'SEALED_UNMERGED' LIMIT 1",
        [absorbedId],
      );
      if (sealedQueryResult.rows[0] !== undefined) {
        committedRunSet.add(absorbedId);
      }
    }
  }
  committedRunSet.add(runId);
  return Object.freeze(Array.from(committedRunSet));
}

/**
 * Merges a single `PgTopologyOverlayRow` into `harness_topology_base` via 3-way merge
 * and allocates a monotonically increasing base epoch (`currentBase.epoch + 1`) in PostgreSQL.
 *
 * @param {PostgresQueryClient}  client - Active PostgreSQL query client.
 * @param {PgTopologyOverlayRow} ovRow  - Overlay partition row to merge and commit.
 * @param {string}               runId  - Committing flow run identifier.
 *
 * @returns {Promise<number>} Newly allocated canonical base epoch for `ovRow.partition_id`.
 */
export async function mergeAndCommitPgOverlayRow(
  client: PostgresQueryClient,
  ovRow: PgTopologyOverlayRow,
  runId: string,
): Promise<number> {
  const baseQueryResult = await client.query<PgTopologyBaseRow>(
    'SELECT * FROM harness_topology_base WHERE partition_id = $1',
    [ovRow.partition_id],
  );
  const baseRow = baseQueryResult.rows[0];
  const currentBaseText = baseRow?.contract_text ?? '';
  const currentBaseEpoch = baseRow?.epoch ?? 0;
  const mergeBaseText =
    currentBaseText === ovRow.initial_base_contract_text
      ? ovRow.initial_base_contract_text
      : ovRow.base_contract_text_at_acquire;
  const mergedText = threeWayMergeContract(mergeBaseText, currentBaseText, ovRow.contract_text);
  const nextBaseEpoch = currentBaseEpoch + 1;
  const now = new Date().toISOString();
  await client.query(
    'INSERT INTO harness_topology_base (partition_id, epoch, contract_text, updated_at, last_mutated_by_run_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (partition_id) DO UPDATE SET epoch = EXCLUDED.epoch, contract_text = EXCLUDED.contract_text, updated_at = EXCLUDED.updated_at, last_mutated_by_run_id = EXCLUDED.last_mutated_by_run_id',
    [ovRow.partition_id, nextBaseEpoch, mergedText, now, ovRow.last_mutated_by_run_id ?? runId],
  );
  return nextBaseEpoch;
}
