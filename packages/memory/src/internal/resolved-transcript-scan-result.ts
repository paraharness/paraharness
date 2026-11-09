/**
 * Result returned by `resolveTranscriptEpochAndRole` (§7.1.2, §7.2 Step 1).
 */
export interface ResolvedTranscriptScanResult {
  /** Resolved compaction checkpoint ID (`'epoch-0'` or the latest compaction boundary ID). */
  readonly currentCheckpointId: string;
  /** Latest `memory_init` role argument discovered in the scanned transcript slice, if any. */
  readonly transcriptInitRole: string | undefined;
  /** Normalized touched paths extracted from Antigravity tool steps in the scanned slice (§7.1.2). */
  readonly extractedTouchedPaths: readonly string[];
  /** Current byte length of `transcriptPath` when readable (`undefined` when omitted or unreadable). */
  readonly transcriptByteLength: number | undefined;
  /** Whether a full rescan from byte offset `0` was performed. */
  readonly performedFullScan: boolean;
}
