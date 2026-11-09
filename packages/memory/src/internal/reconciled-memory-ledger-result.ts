import type { MemoryMeta, MemoryRecord } from '../schemas/memory-record.schema.js';

/**
 * Input ledger state (`records` and `meta`) for one branch of a 3-way Git reconciliation.
 */
export interface MemoryBranchLedgerState {
  /** Active or committed records at this branch revision. */
  readonly records: readonly MemoryRecord[];
  /** Monotonic high-water-mark metadata at this branch revision. */
  readonly meta: MemoryMeta;
}

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
  /** Reference to `MemoryBranchLedgerState` for reachability under `Rule 1.2`. */
  readonly branchStateType?: MemoryBranchLedgerState;
}
