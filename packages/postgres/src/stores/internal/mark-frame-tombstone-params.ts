/**
 * Parameter object for `markFrameTombstoneInPg`.
 *
 * Bundles the run ID, message frame ID, tool call ID, and compacted tombstone replacement string.
 */
export interface MarkFrameTombstoneParams {
  /** Enclosing flow run identifier. */
  readonly runId: string;
  /** Target `WireFrameRecord.messageId`. */
  readonly messageId: string;
  /** Tool call ID of the `activateSkill` invocation. */
  readonly callId: string;
  /** Tombstone replacement string used on cross-model escalations. */
  readonly compactedTombstone: string;
}
