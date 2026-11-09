import type { MemoryMeta, MemoryRecord } from '../schemas/memory-record.schema.js';

/**
 * Result of a deterministic 3-way ledger and metadata reconciliation (§8.2.3).
 */
export interface ReconciledMemoryLedgerResult {
  /** Canonically sorted merged records (`R*` -> `L*` -> `N*`). */
  readonly records: readonly MemoryRecord[];
  /** Merged monotonic high-water-mark metadata. */
  readonly meta: MemoryMeta;
  /** Mapping from colliding local record IDs to their newly assigned monotonic IDs (`oldId -> newId`). */
  readonly idRemap: ReadonlyMap<string, string>;
}
