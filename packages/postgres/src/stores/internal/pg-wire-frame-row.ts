/**
 * Relational row shape for `harness_wire_frames` in PostgreSQL.
 *
 * Stores raw vendor wire bytes (`BYTEA` / `Uint8Array`), canonical message projections,
 * prefix digests, and compacted skill tombstones.
 */
export interface PgWireFrameRow {
  /** Primary key message frame identifier. */
  readonly message_id: string;
  /** Enclosing flow run identifier. */
  readonly run_id: string;
  /** Parent message frame identifier or `null` for Turn 0. */
  readonly parent_message_id: string | null;
  /** Provider vendor identifier. */
  readonly vendor_id: string;
  /** Raw vendor wire bytes (`Buffer` or `Uint8Array`). */
  readonly raw_wire_frame: Uint8Array;
  /** JSON-serialized `CanonicalMessage` projection. */
  readonly canonical_json: string;
  /** SHA-256 hex digest of the active wire prefix. */
  readonly prefix_digest: string;
  /** JSON-serialized `Record<string, string>` of skill tombstones or `null`. */
  readonly compacted_tombstones_json: string | null;
  /** `1` if raw wire bytes have been pruned by compaction, otherwise `0`. */
  readonly compacted: number;
}
