import type { CanonicalMessage, WireFrameRecord } from '@paraharness/core';
import type { PgWireFrameRow } from './pg-wire-frame-row.js';

/**
 * Serializes a `WireFrameRecord`'s optional `compactedTombstones` map into a nullable JSON column string.
 *
 * Returns `null` when `frame.compactedTombstones` is `undefined`.
 *
 * @param {WireFrameRecord} frame - Wire frame record whose tombstones are being serialized.
 *
 * @returns {string | null} JSON string or `null`.
 */
export function serializePgFrameTombstonesJson(frame: WireFrameRecord): string | null {
  if (frame.compactedTombstones === undefined) {
    return null;
  }
  return JSON.stringify(frame.compactedTombstones);
}

/**
 * Maps a persisted `PgWireFrameRow` database row into an immutable `WireFrameRecord`.
 *
 * Reconstructs the `Uint8Array` raw wire frame buffer, parses `canonical_json`, and freezes
 * any `compacted_tombstones_json` dictionary.
 *
 * @param {PgWireFrameRow} row - Database row from `harness_wire_frames`.
 *
 * @returns {WireFrameRecord} Frozen wire frame record.
 */
export function mapPgRowToWireFrameRecord(row: PgWireFrameRow): WireFrameRecord {
  const tombstones =
    row.compacted_tombstones_json !== null
      ? Object.freeze(JSON.parse(row.compacted_tombstones_json) as Record<string, string>)
      : undefined;
  return Object.freeze<WireFrameRecord>({
    messageId: row.message_id,
    parentMessageId: row.parent_message_id,
    vendorId: row.vendor_id,
    rawWireFrame: new Uint8Array(row.raw_wire_frame),
    canonical: Object.freeze(JSON.parse(row.canonical_json) as CanonicalMessage),
    prefixDigest: row.prefix_digest,
    compactedTombstones: tombstones,
  });
}
