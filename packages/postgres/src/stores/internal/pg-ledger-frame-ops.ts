import type { CanonicalMessage, WireFrameRecord } from '@harness-dsl/core';
import type { PostgresQueryClient } from '../../ddl/postgres-query-client.js';
import type { PostgresQueryResult } from '../../ddl/postgres-query-result.js';
import type { MarkFrameTombstoneParams } from './mark-frame-tombstone-params.js';
import type { PgWireFrameRow } from './pg-wire-frame-row.js';

/**
 * Appends a new `WireFrameRecord` to `harness_wire_frames` for `runId` in PostgreSQL.
 *
 * Stores the raw vendor wire bytes (`BYTEA`), canonical message JSON, prefix digest,
 * and optional skill tombstones keyed by `frame.messageId`.
 *
 * @param {PostgresQueryClient} client - Active PostgreSQL query client.
 * @param {string}              runId  - Enclosing flow run identifier.
 * @param {WireFrameRecord}     frame  - Immutable wire frame record to append.
 *
 * @returns {Promise<void>} Resolves once the wire frame row is inserted.
 */
export async function appendMessageFrameInPg(
  client: PostgresQueryClient,
  runId: string,
  frame: WireFrameRecord,
): Promise<void> {
  const tombstonesJson =
    frame.compactedTombstones !== undefined ? JSON.stringify(frame.compactedTombstones) : null;
  await client.query(
    'INSERT INTO harness_wire_frames (message_id, run_id, parent_message_id, vendor_id, raw_wire_frame, canonical_json, prefix_digest, compacted_tombstones_json, compacted) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0) ON CONFLICT (message_id) DO UPDATE SET run_id = EXCLUDED.run_id, parent_message_id = EXCLUDED.parent_message_id, vendor_id = EXCLUDED.vendor_id, raw_wire_frame = EXCLUDED.raw_wire_frame, canonical_json = EXCLUDED.canonical_json, prefix_digest = EXCLUDED.prefix_digest, compacted_tombstones_json = EXCLUDED.compacted_tombstones_json, compacted = 0',
    [
      frame.messageId,
      runId,
      frame.parentMessageId,
      frame.vendorId,
      Buffer.from(frame.rawWireFrame),
      JSON.stringify(frame.canonical),
      frame.prefixDigest,
      tombstonesJson,
    ],
  );
}

/**
 * Replaces an existing `WireFrameRecord` in-place (such as after `appendToolResultNotes`) in PostgreSQL.
 *
 * Updates `raw_wire_frame`, `canonical_json`, `prefix_digest`, and `compacted_tombstones_json`
 * while preserving `messageId` and `parentMessageId` links.
 *
 * @param {PostgresQueryClient} client - Active PostgreSQL query client.
 * @param {string}              runId  - Enclosing flow run identifier.
 * @param {WireFrameRecord}     frame  - Updated wire frame record.
 *
 * @returns {Promise<void>} Resolves once the frame row is updated.
 */
export async function replaceMessageFrameInPg(
  client: PostgresQueryClient,
  runId: string,
  frame: WireFrameRecord,
): Promise<void> {
  const tombstonesJson =
    frame.compactedTombstones !== undefined ? JSON.stringify(frame.compactedTombstones) : null;
  await client.query(
    'UPDATE harness_wire_frames SET raw_wire_frame = $1, canonical_json = $2, prefix_digest = $3, compacted_tombstones_json = COALESCE($4, compacted_tombstones_json) WHERE message_id = $5 AND run_id = $6',
    [
      Buffer.from(frame.rawWireFrame),
      JSON.stringify(frame.canonical),
      frame.prefixDigest,
      tombstonesJson,
      frame.messageId,
      runId,
    ],
  );
}

/**
 * Records a per-`callId` compacted skill tombstone on an earlier `activateSkill` message frame in PostgreSQL.
 *
 * Updates `compacted_tombstones_json` without mutating `raw_wire_frame` so same-model KV cache prefixes remain intact.
 *
 * @param {PostgresQueryClient}      client - Active PostgreSQL query client.
 * @param {MarkFrameTombstoneParams} params - Tombstone target and replacement string.
 *
 * @returns {Promise<void>} Resolves once the tombstone map is updated.
 */
export async function markFrameTombstoneInPg(
  client: PostgresQueryClient,
  params: MarkFrameTombstoneParams,
): Promise<void> {
  const res = await client.query<{ readonly compacted_tombstones_json: string | null }>(
    'SELECT compacted_tombstones_json FROM harness_wire_frames WHERE message_id = $1 AND run_id = $2',
    [params.messageId, params.runId],
  );
  const row = res.rows[0];
  if (row === undefined) return;
  const currentMap: Record<string, string> =
    row.compacted_tombstones_json !== null
      ? (JSON.parse(row.compacted_tombstones_json) as Record<string, string>)
      : {};
  currentMap[params.callId] = params.compactedTombstone;
  await client.query(
    'UPDATE harness_wire_frames SET compacted_tombstones_json = $1 WHERE message_id = $2 AND run_id = $3',
    [JSON.stringify(currentMap), params.messageId, params.runId],
  );
}

/**
 * Reconstructs the chronological root-to-leaf `WireFrameRecord[]` ancestor chain ending at `leafMessageId` in PostgreSQL.
 *
 * Walks `parent_message_id` pointers from `leafMessageId` back to the Turn-0 root frame and reverses into root-to-leaf order.
 *
 * @param {PostgresQueryClient} client        - Active PostgreSQL query client.
 * @param {string}              leafMessageId - Identifier of the trailing message frame in the chain.
 *
 * @returns {Promise<readonly WireFrameRecord[]>} Ordered root-to-leaf wire frame sequence.
 */
export async function getMessageChainFromPg(
  client: PostgresQueryClient,
  leafMessageId: string,
): Promise<readonly WireFrameRecord[]> {
  const reversed: WireFrameRecord[] = [];
  const visited = new Set<string>();
  let currentId: string | null = leafMessageId;
  while (currentId !== null) {
    if (visited.has(currentId)) {
      throw new Error(`Cycle detected in wire frame chain at messageId '${currentId}'.`);
    }
    visited.add(currentId);
    const res: PostgresQueryResult<PgWireFrameRow> = await client.query<PgWireFrameRow>(
      'SELECT * FROM harness_wire_frames WHERE message_id = $1',
      [currentId],
    );
    const row: PgWireFrameRow | undefined = res.rows[0];
    if (row === undefined) break;
    const tombstones =
      row.compacted_tombstones_json !== null
        ? Object.freeze(JSON.parse(row.compacted_tombstones_json) as Record<string, string>)
        : undefined;
    reversed.push(
      Object.freeze<WireFrameRecord>({
        messageId: row.message_id,
        parentMessageId: row.parent_message_id,
        vendorId: row.vendor_id,
        rawWireFrame: new Uint8Array(row.raw_wire_frame),
        canonical: Object.freeze(JSON.parse(row.canonical_json) as CanonicalMessage),
        prefixDigest: row.prefix_digest,
        compactedTombstones: tombstones,
      }),
    );
    currentId = row.parent_message_id;
  }
  reversed.reverse();
  return Object.freeze(reversed);
}
