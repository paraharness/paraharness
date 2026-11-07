import type { PostgresQueryClient } from '../../ddl/postgres-query-client.js';

/**
 * Prunes raw `WireFrameRecord` payloads (`raw_wire_frame`) for a terminal `runId` in PostgreSQL.
 *
 * Verifies that `runId` is not in an active non-terminal state (`QUEUED`, `RUNNING`, `WAITING`, `SUSPENDED`)
 * and scopes the update strictly to `run_id = $2` so newer runs for the same `itemKey` are never affected
 * while canonical audit headers (`canonical_json`, `prefix_digest`) remain intact (`SPEC.md` §3.10).
 *
 * @param {PostgresQueryClient} client - Active PostgreSQL query client.
 * @param {string}              runId  - Terminal flow run identifier to compact.
 *
 * @returns {Promise<void>} Resolves once raw wire frames for `runId` are pruned.
 */
export async function compactRunFramesInPg(
  client: PostgresQueryClient,
  runId: string,
): Promise<void> {
  const queryResult = await client.query<{ readonly status: string }>(
    'SELECT status FROM harness_runs WHERE run_id = $1',
    [runId],
  );
  const runRow = queryResult.rows[0];
  if (
    runRow !== undefined &&
    (runRow.status === 'QUEUED' ||
      runRow.status === 'RUNNING' ||
      runRow.status === 'WAITING' ||
      runRow.status === 'SUSPENDED')
  ) {
    return;
  }
  await client.query(
    'UPDATE harness_wire_frames SET raw_wire_frame = $1, compacted = 1 WHERE run_id = $2',
    [Buffer.alloc(0), runId],
  );
}
