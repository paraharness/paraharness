import type { CommitRunOverlayResult } from '@metaharness/core';
import type { PostgresQueryClient } from '../../ddl/postgres-query-client.js';
import type { PgTopologyOverlayRow } from './pg-topology-overlay-row.js';
import {
  collectCommittedPgRunIds,
  mergeAndCommitPgOverlayRow,
} from './postgres-topology-overlay-commit.js';

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
  const ovQueryResult = await client.query<PgTopologyOverlayRow>(
    'SELECT * FROM harness_topology_overlays WHERE run_id = $1 AND (mutated_in_run = 1 OR has_uncommitted_changes = 1) ORDER BY partition_id ASC',
    [runId],
  );
  const committedRunIds = await collectCommittedPgRunIds(client, runId, ovQueryResult.rows);
  const updatedEpochs = new Map<string, number>();
  for (const ovRow of ovQueryResult.rows) {
    const nextBaseEpoch = await mergeAndCommitPgOverlayRow(client, ovRow, runId);
    updatedEpochs.set(ovRow.partition_id, nextBaseEpoch);
  }
  for (const committedId of committedRunIds) {
    await client.query('DELETE FROM harness_topology_overlays WHERE run_id = $1', [committedId]);
  }
  return Object.freeze<CommitRunOverlayResult>({
    committedRunIds,
    updatedEpochs,
  });
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
