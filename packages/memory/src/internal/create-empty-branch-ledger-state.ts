import type { MemoryMeta } from '../schemas/memory-record.schema.js';
import type { MemoryBranchLedgerState } from './memory-branch-ledger-state.js';

/**
 * Returns an empty `MemoryBranchLedgerState` (`records: []`, `highWaterMarks: { R: 0, L: 0, N: 0 }`).
 *
 * @returns {MemoryBranchLedgerState} Frozen empty branch ledger state.
 */
export function createEmptyBranchLedgerState(): MemoryBranchLedgerState {
  const emptyMeta: MemoryMeta = Object.freeze({
    schemaVersion: 1,
    highWaterMarks: Object.freeze({ R: 0, L: 0, N: 0 }),
  });
  return Object.freeze<MemoryBranchLedgerState>({
    records: Object.freeze([]),
    meta: emptyMeta,
  });
}
