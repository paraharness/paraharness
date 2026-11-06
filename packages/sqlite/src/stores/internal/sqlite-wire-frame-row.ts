/**
 * Raw SQLite row shape for `harness_wire_frames`.
 *
 * Maps snake_case database columns to typed properties for wire-frame append, replacement, and chain queries.
 */
export interface SqliteWireFrameRow {
  /** Unique wire frame message identifier. */
  readonly message_id: string;
  /** Enclosing flow run identifier. */
  readonly run_id: string;
  /** Preceding message identifier in the chain, or `null` for Turn 0. */
  readonly parent_message_id: string | null;
  /** Model vendor identifier string. */
  readonly vendor_id: string;
  /** Raw UTF-8 encoded vendor wire frame buffer. */
  readonly raw_wire_frame: Buffer;
  /** JSON-serialized `CanonicalMessage` projection. */
  readonly canonical_json: string;
  /** SHA-256 hex digest of the compiled wire prefix. */
  readonly prefix_digest: string;
  /** Optional JSON-serialized `Record<string, string>` of skill tombstones. */
  readonly compacted_tombstones_json: string | null;
  /** Compaction flag (`1` when raw wire bytes have been pruned, `0` otherwise). */
  readonly is_compacted: number;
}
