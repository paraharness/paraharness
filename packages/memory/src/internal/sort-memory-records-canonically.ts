import type { MemoryRecord } from '../schemas/memory-record.schema.js';
import { MEMORY_TYPE_RANK } from './memory-protocol.constants.js';

/**
 * Parses the numeric suffix of a memory record identifier (`R12` -> `12`).
 *
 * @param {string} recordId - Memory record identifier (`R<n>`, `L<n>`, or `N<n>`).
 *
 * @returns {number} Positive integer numeric suffix of `recordId`.
 */
export function parseRecordNumericId(recordId: string): number {
  return Number(recordId.slice(1));
}

/**
 * Compares two `MemoryRecord` objects according to the §1.2 and §3.1 canonical presentation order:
 * rules (`R*`) first, lessons (`L*`) second, notes (`N*`) third, and ascending numeric ID within each type.
 *
 * @param {MemoryRecord} left  - First record to compare.
 * @param {MemoryRecord} right - Second record to compare.
 *
 * @returns {number} Negative if `left < right`, positive if `left > right`, or `0` if equal.
 */
export function compareMemoryRecordsCanonically(left: MemoryRecord, right: MemoryRecord): number {
  const rankDiff = MEMORY_TYPE_RANK[left.type] - MEMORY_TYPE_RANK[right.type];
  if (rankDiff !== 0) {
    return rankDiff;
  }
  return parseRecordNumericId(left.id) - parseRecordNumericId(right.id);
}

/**
 * Returns a new frozen array containing `records` sorted in §3.1 canonical deterministic order
 * (`R*` -> `L*` -> `N*`, ascending numeric ID).
 *
 * @template T Record subtype extending `MemoryRecord`.
 *
 * @param {readonly T[]} records - Input records to sort without mutating the source array.
 *
 * @returns {readonly T[]} Frozen canonically sorted array of records.
 */
export function sortMemoryRecordsCanonically<T extends MemoryRecord>(
  records: readonly T[],
): readonly T[] {
  const copy = [...records];
  copy.sort(compareMemoryRecordsCanonically);
  return Object.freeze(copy);
}
