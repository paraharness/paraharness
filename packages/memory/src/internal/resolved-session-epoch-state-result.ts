import type { MemorySessionEpochState } from '../schemas/memory-tools.schema.js';

/**
 * Result returned by `resolveSessionEpochState` (§7.2 Steps 1–2).
 */
export interface ResolvedSessionEpochStateResult {
  /** Updated per-session compaction epoch state. */
  readonly state: MemorySessionEpochState;
  /** Resolved active role for this session and hook invocation. */
  readonly resolvedRole: string;
  /** Active compaction checkpoint identifier. */
  readonly compactionEpochId: string;
  /** Normalized touched paths extracted from `transcript.jsonl` tool steps during the scan (§7.1.2). */
  readonly transcriptTouchedPaths: readonly string[];
  /** Whether `seenRecordIds` was reset due to a new session or compaction epoch transition. */
  readonly epochReset: boolean;
  /** Whether `PENDING_HOOK_EPOCH` was bound to `compactionEpochId` while preserving `seenRecordIds`. */
  readonly boundPendingHookEpoch: boolean;
}
