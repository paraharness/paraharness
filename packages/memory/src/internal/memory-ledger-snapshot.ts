import type { MemoryMeta, MemoryRecord } from '../schemas/memory-record.schema.js';

/**
 * Snapshot of `memory.jsonl` and `memory.meta.json` returned by `readMemoryLedger` (§3.1, §3.3).
 */
export interface MemoryLedgerSnapshot {
  /** Active (non-hard-expired) records sorted in §3.1 canonical order (`R*` -> `L*` -> `N*`). */
  readonly records: readonly MemoryRecord[];
  /** Raw records loaded from `memory.jsonl` prior to purging expired `hard-expiry` notes. */
  readonly rawRecords: readonly MemoryRecord[];
  /** Monotonic high-water-mark metadata reconciled across all `rawRecords` before expiry purge. */
  readonly meta: MemoryMeta;
  /** Whether `memory.jsonl` existed on disk at read time. */
  readonly ledgerExisted: boolean;
  /** Whether `memory.meta.json` existed on disk at read time. */
  readonly metaExisted: boolean;
  /** Whether `memory.meta.json` was newly initialized or had its `highWaterMarks` advanced. */
  readonly metaNeedsWrite: boolean;
  /** Identifiers of `hard-expiry` notes whose `expiresAt` had elapsed at `nowMs`. */
  readonly purgedExpiredNoteIds: readonly string[];
  /** Whether `memory.jsonl` needs to be rewritten due to purged `hard-expiry` notes. */
  readonly ledgerNeedsWrite: boolean;
}
