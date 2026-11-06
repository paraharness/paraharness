/**
 * Parameter object for `markFrameTombstoneInSqlite`.
 *
 * Bundles the run ID, target message ID, tool call ID, and compacted tombstone text.
 */
export interface MarkFrameTombstoneParams {
  /** Enclosing flow run identifier. */
  readonly runId: string;
  /** Target wire frame message identifier. */
  readonly messageId: string;
  /** Tool call ID of the unmounted skill activation. */
  readonly callId: string;
  /** Compacted tombstone replacement string. */
  readonly compactedTombstone: string;
}
