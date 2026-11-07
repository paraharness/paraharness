import type { CanonicalMessage, WireFrameRecord } from '@harness-dsl/core';
import type Database from 'better-sqlite3';
import type { MarkFrameTombstoneParams } from './mark-frame-tombstone-params.js';
import type { SqliteWireFrameRow } from './sqlite-wire-frame-row.js';

/**
 * Appends a `WireFrameRecord` to `harness_wire_frames` for `runId`.
 *
 * Persists both the raw vendor wire BLOB and the vendor-neutral `CanonicalMessage` JSON.
 *
 * @param {Database.Database} db    - Active SQLite database handle.
 * @param {string}            runId - Enclosing flow run identifier.
 * @param {WireFrameRecord}   frame - Immutable wire frame record to append.
 *
 * @returns {void} Returns nothing once the frame is inserted.
 */
export function appendMessageFrameInSqlite(
  db: Database.Database,
  runId: string,
  frame: WireFrameRecord,
): void {
  const tombstonesJson =
    frame.compactedTombstones !== undefined ? JSON.stringify(frame.compactedTombstones) : null;
  db.prepare(
    'INSERT INTO harness_wire_frames (message_id, run_id, parent_message_id, vendor_id, raw_wire_frame, canonical_json, prefix_digest, compacted_tombstones_json, is_compacted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)',
  ).run(
    frame.messageId,
    runId,
    frame.parentMessageId,
    frame.vendorId,
    Buffer.from(frame.rawWireFrame),
    JSON.stringify(frame.canonical),
    frame.prefixDigest,
    tombstonesJson,
  );
}

/**
 * Replaces an existing `WireFrameRecord` in-place in `harness_wire_frames`.
 *
 * Updates `raw_wire_frame`, `canonical_json`, and `compacted_tombstones_json` while preserving chain links.
 *
 * @param {Database.Database} db    - Active SQLite database handle.
 * @param {string}            runId - Enclosing flow run identifier.
 * @param {WireFrameRecord}   frame - Updated wire frame record.
 *
 * @returns {void} Returns nothing once the frame is updated.
 */
export function replaceMessageFrameInSqlite(
  db: Database.Database,
  runId: string,
  frame: WireFrameRecord,
): void {
  const tombstonesJson =
    frame.compactedTombstones !== undefined ? JSON.stringify(frame.compactedTombstones) : null;
  const updateResult = db
    .prepare(
      'UPDATE harness_wire_frames SET raw_wire_frame = ?, canonical_json = ?, prefix_digest = ?, compacted_tombstones_json = COALESCE(?, compacted_tombstones_json) WHERE message_id = ? AND run_id = ?',
    )
    .run(
      Buffer.from(frame.rawWireFrame),
      JSON.stringify(frame.canonical),
      frame.prefixDigest,
      tombstonesJson,
      frame.messageId,
      runId,
    );
  if (updateResult.changes === 0) {
    throw new Error(`Cannot replace message frame '${frame.messageId}' for runId '${runId}': frame not found.`);
  }
}

/**
 * Records a per-`callId` skill tombstone on an existing `WireFrameRecord` without mutating `raw_wire_frame`.
 *
 * Preserves byte-identical `raw_wire_frame` for same-model KV-cache hits while recording cross-model tombstones.
 *
 * @param {Database.Database}        db     - Active SQLite database handle.
 * @param {MarkFrameTombstoneParams} params - Tombstone target coordinates and replacement string.
 *
 * @returns {void} Returns nothing once the tombstone map is updated.
 */
export function markFrameTombstoneInSqlite(
  db: Database.Database,
  params: MarkFrameTombstoneParams,
): void {
  const row = db
    .prepare('SELECT compacted_tombstones_json FROM harness_wire_frames WHERE message_id = ? AND run_id = ?')
    .get(params.messageId, params.runId) as { readonly compacted_tombstones_json: string | null } | undefined;
  if (row === undefined) {
    throw new Error(`Cannot mark tombstone on unknown messageId '${params.messageId}' in runId '${params.runId}'.`);
  }
  const tombstones: Record<string, string> =
    row.compacted_tombstones_json !== null
      ? (JSON.parse(row.compacted_tombstones_json) as Record<string, string>)
      : {};
  tombstones[params.callId] = params.compactedTombstone;
  db.prepare('UPDATE harness_wire_frames SET compacted_tombstones_json = ? WHERE message_id = ? AND run_id = ?')
    .run(JSON.stringify(tombstones), params.messageId, params.runId);
}

/**
 * Reconstructs the chronological root-to-leaf `WireFrameRecord[]` chain ending at `leafMessageId`.
 *
 * Walks `parent_message_id` pointers from `leafMessageId` to the root frame and reverses the sequence.
 *
 * @param {Database.Database} db            - Active SQLite database handle.
 * @param {string}            leafMessageId - Identifier of the trailing message frame.
 *
 * @returns {readonly WireFrameRecord[]} Ordered root-to-leaf wire frame records.
 */
export function getMessageChainFromSqlite(
  db: Database.Database,
  leafMessageId: string,
): readonly WireFrameRecord[] {
  const stmt = db.prepare('SELECT * FROM harness_wire_frames WHERE message_id = ?');
  const reversedChain: WireFrameRecord[] = [];
  const visited = new Set<string>();
  let currentId: string | null = leafMessageId;
  while (currentId !== null) {
    if (visited.has(currentId)) throw new Error(`Cycle detected in wire frame parent chain at messageId '${currentId}'.`);
    visited.add(currentId);
    const row = stmt.get(currentId) as SqliteWireFrameRow | undefined;
    if (row === undefined) break;
    const tombstones = row.compacted_tombstones_json !== null
      ? Object.freeze(JSON.parse(row.compacted_tombstones_json) as Record<string, string>)
      : undefined;
    reversedChain.push(Object.freeze<WireFrameRecord>({
      messageId: row.message_id, parentMessageId: row.parent_message_id, vendorId: row.vendor_id,
      rawWireFrame: new Uint8Array(row.raw_wire_frame), canonical: JSON.parse(row.canonical_json) as CanonicalMessage,
      prefixDigest: row.prefix_digest, compactedTombstones: tombstones,
    }));
    currentId = row.parent_message_id;
  }
  reversedChain.reverse();
  return Object.freeze(reversedChain);
}
