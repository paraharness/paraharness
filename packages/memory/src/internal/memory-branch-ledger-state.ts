import type { MemoryMeta, MemoryRecord } from '../schemas/memory-record.schema.js';

/**
 * Input ledger state (`records` and `meta`) for one branch of a 3-way Git reconciliation (§8.2.3).
 */
export interface MemoryBranchLedgerState {
  /** Active or committed records at this branch revision. */
  readonly records: readonly MemoryRecord[];
  /** Monotonic high-water-mark metadata at this branch revision. */
  readonly meta: MemoryMeta;
}
