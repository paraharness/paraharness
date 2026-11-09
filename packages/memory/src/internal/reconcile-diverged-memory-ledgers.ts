import type {
  MemoryMeta,
  MemoryNoteRecord,
  MemoryRecord,
} from '../schemas/memory-record.schema.js';
import type { MemoryBranchLedgerState } from './memory-branch-ledger-state.js';
import type { ReconciledMemoryLedgerResult } from './reconciled-memory-ledger-result.js';
import {
  parseRecordNumericId,
  sortMemoryRecordsCanonically,
} from './sort-memory-records-canonically.js';

/**
 * Parameter object for `renumberCollidingLocalAdditions`.
 */
export interface RenumberCollidingLocalAdditionsParams {
  /** Common ancestor ledger state. */
  readonly base: MemoryBranchLedgerState;
  /** Local `HEAD` ledger state. */
  readonly local: MemoryBranchLedgerState;
  /** Remote `origin/<branch>` ledger state. */
  readonly remote: MemoryBranchLedgerState;
  /** Mutable per-prefix high-water-mark floor updated in-place. */
  readonly nextFloor: { R: number; L: number; N: number };
}

/**
 * Computes the maximum numeric ID for `prefix` across `records`.
 *
 * @param {readonly MemoryRecord[]} records - Records to inspect.
 * @param {'R' | 'L' | 'N'}         prefix  - Record ID prefix (`'R'`, `'L'`, or `'N'`).
 *
 * @returns {number} Highest integer ID suffix found for `prefix`, or `0` when none exist.
 */
function maxNumericIdForPrefix(
  records: readonly MemoryRecord[],
  prefix: 'R' | 'L' | 'N',
): number {
  let maxId = 0;
  for (const record of records) {
    if (record.id.startsWith(prefix)) {
      const numericId = parseRecordNumericId(record.id);
      if (Number.isInteger(numericId) && numericId > maxId) {
        maxId = numericId;
      }
    }
  }
  return maxId;
}

/**
 * Returns the numeric timestamp (`Date.parse(record.updatedAt ?? record.createdAt)`) for a record (§8.2.3).
 *
 * @param {MemoryRecord} record - Record whose last-modified timestamp is evaluated.
 *
 * @returns {number} Epoch milliseconds of `record.updatedAt ?? record.createdAt`.
 */
function getRecordTimestampMs(record: MemoryRecord): number {
  return Date.parse(record.updatedAt ?? record.createdAt);
}

/**
 * Checks whether two records are identical across all persisted fields.
 *
 * @param {MemoryRecord} left  - First record.
 * @param {MemoryRecord} right - Second record.
 *
 * @returns {boolean} `true` if `left` and `right` serialize identically.
 */
function areRecordsIdentical(left: MemoryRecord, right: MemoryRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Checks whether a newly added local record is already present identically at the same ID in `remote` (§8.2.3).
 *
 * @param {MemoryRecord}             localRecord  - Local record absent from `base`.
 * @param {MemoryRecord | undefined} remoteRecord - Remote record at `localRecord.id`, if any.
 *
 * @returns {boolean} `true` if `remoteRecord` exists and has identical `type`, `role`, `text`, and `createdAt`.
 */
function isSameAddedRecordInRemote(
  localRecord: MemoryRecord,
  remoteRecord: MemoryRecord | undefined,
): boolean {
  if (remoteRecord === undefined) {
    return false;
  }
  return (
    remoteRecord.type === localRecord.type &&
    remoteRecord.role === localRecord.role &&
    remoteRecord.text === localRecord.text &&
    remoteRecord.createdAt === localRecord.createdAt
  );
}

/**
 * Re-numbers newly added local records that collide with `remote` records or fall at or below
 * `remote.meta.highWaterMarks` (§8.2.3 Step 2).
 *
 * @param {RenumberCollidingLocalAdditionsParams} params - Ancestor, local, and remote ledger states plus mutable `nextFloor`.
 *
 * @returns {{ readonly remappedLocal: readonly MemoryRecord[]; readonly idRemap: Map<string, string> }} Re-numbered local records and `oldId -> newId` map.
 */
function renumberCollidingLocalAdditions(
  params: RenumberCollidingLocalAdditionsParams,
): { readonly remappedLocal: readonly MemoryRecord[]; readonly idRemap: Map<string, string> } {
  const baseById = new Map<string, MemoryRecord>();
  for (const rec of params.base.records) baseById.set(rec.id, rec);
  const remoteById = new Map<string, MemoryRecord>();
  for (const rec of params.remote.records) remoteById.set(rec.id, rec);
  const sortedLocal = sortMemoryRecordsCanonically(params.local.records);
  const remappedLocal: MemoryRecord[] = [];
  const idRemap = new Map<string, string>();
  for (const locRec of sortedLocal) {
    if (baseById.has(locRec.id)) {
      remappedLocal.push(locRec);
      continue;
    }
    const remRec = remoteById.get(locRec.id);
    if (isSameAddedRecordInRemote(locRec, remRec)) {
      remappedLocal.push(locRec);
      continue;
    }
    const prefix: 'R' | 'L' | 'N' =
      locRec.type === 'rule' ? 'R' : locRec.type === 'lesson' ? 'L' : 'N';
    const numericId = parseRecordNumericId(locRec.id);
    const collidesWithRemoteAddition = remRec !== undefined && !baseById.has(locRec.id);
    const belowRemoteMark = numericId <= params.remote.meta.highWaterMarks[prefix];
    if (belowRemoteMark || collidesWithRemoteAddition) {
      params.nextFloor[prefix] += 1;
      const newId = `${prefix}${params.nextFloor[prefix]}`;
      idRemap.set(locRec.id, newId);
      remappedLocal.push(Object.freeze({ ...locRec, id: newId }));
      continue;
    }
    remappedLocal.push(locRec);
  }
  return { remappedLocal, idRemap };
}

/**
 * Merges a single record ID present in both `local` and `remote` relative to `base` (§8.2.3 Step 2).
 *
 * @param {MemoryRecord | undefined} baseRec   - Record version in `base` (`undefined` if absent).
 * @param {MemoryRecord}             localRec  - Record version in `local`.
 * @param {MemoryRecord}             remoteRec - Record version in `remote`.
 *
 * @returns {MemoryRecord | null} Winning or merged record, or `null` if a `read-count` note drained to `<= 0`.
 */
function mergeRecordPresentInBothBranches(
  baseRec: MemoryRecord | undefined,
  localRec: MemoryRecord,
  remoteRec: MemoryRecord,
): MemoryRecord | null {
  if (
    localRec.type === 'note' &&
    remoteRec.type === 'note' &&
    localRec.lifecycle.mode === 'read-count' &&
    remoteRec.lifecycle.mode === 'read-count'
  ) {
    const baseTs = baseRec !== undefined ? getRecordTimestampMs(baseRec) : null;
    const localDidNotAdvance =
      baseTs !== null
        ? getRecordTimestampMs(localRec) <= baseTs
        : localRec.updatedAt === remoteRec.updatedAt;
    const remoteDidNotAdvance =
      baseTs !== null
        ? getRecordTimestampMs(remoteRec) <= baseTs
        : localRec.updatedAt === remoteRec.updatedAt;
    if (localDidNotAdvance && remoteDidNotAdvance) {
      const mergedRemaining =
        baseRec !== undefined &&
        baseRec.type === 'note' &&
        baseRec.lifecycle.mode === 'read-count'
          ? baseRec.lifecycle.remainingReads -
            (baseRec.lifecycle.remainingReads - localRec.lifecycle.remainingReads) -
            (baseRec.lifecycle.remainingReads - remoteRec.lifecycle.remainingReads)
          : Math.min(localRec.lifecycle.remainingReads, remoteRec.lifecycle.remainingReads);
      if (mergedRemaining <= 0) {
        return null;
      }
      const mergedNote: MemoryNoteRecord = Object.freeze({
        ...localRec,
        lifecycle: Object.freeze({
          mode: 'read-count',
          remainingReads: mergedRemaining,
        }),
      });
      return mergedNote;
    }
  }
  if (baseRec !== undefined) {
    const localUnchanged = areRecordsIdentical(localRec, baseRec);
    const remoteUnchanged = areRecordsIdentical(remoteRec, baseRec);
    if (localUnchanged && !remoteUnchanged) {
      return remoteRec;
    }
    if (!localUnchanged && remoteUnchanged) {
      return localRec;
    }
  }
  return getRecordTimestampMs(localRec) >= getRecordTimestampMs(remoteRec) ? localRec : remoteRec;
}

/**
 * Reconciles `base`, `local`, and `remote` ledger snapshots via 3-way record merge, monotonic ID
 * collision re-numbering, `read-count` delta subtraction, and `highWaterMarks` union (§8.2.3).
 *
 * @param {MemoryBranchLedgerState} base   - Common ancestor (`merge-base` or empty base) ledger and metadata.
 * @param {MemoryBranchLedgerState} local  - Local `HEAD` ledger and metadata.
 * @param {MemoryBranchLedgerState} remote - Remote `origin/<branch>` ledger and metadata.
 *
 * @returns {ReconciledMemoryLedgerResult} Merged records, merged metadata, and `idRemap` table.
 */
export function reconcileDivergedMemoryLedgers(
  base: MemoryBranchLedgerState,
  local: MemoryBranchLedgerState,
  remote: MemoryBranchLedgerState,
): ReconciledMemoryLedgerResult {
  const nextFloor = {
    R: Math.max(
      base.meta.highWaterMarks.R,
      local.meta.highWaterMarks.R,
      remote.meta.highWaterMarks.R,
      maxNumericIdForPrefix(base.records, 'R'),
      maxNumericIdForPrefix(local.records, 'R'),
      maxNumericIdForPrefix(remote.records, 'R'),
    ),
    L: Math.max(
      base.meta.highWaterMarks.L,
      local.meta.highWaterMarks.L,
      remote.meta.highWaterMarks.L,
      maxNumericIdForPrefix(base.records, 'L'),
      maxNumericIdForPrefix(local.records, 'L'),
      maxNumericIdForPrefix(remote.records, 'L'),
    ),
    N: Math.max(
      base.meta.highWaterMarks.N,
      local.meta.highWaterMarks.N,
      remote.meta.highWaterMarks.N,
      maxNumericIdForPrefix(base.records, 'N'),
      maxNumericIdForPrefix(local.records, 'N'),
      maxNumericIdForPrefix(remote.records, 'N'),
    ),
  };
  const { remappedLocal, idRemap } = renumberCollidingLocalAdditions({
    base,
    local,
    remote,
    nextFloor,
  });
  const baseById = new Map<string, MemoryRecord>();
  for (const rec of base.records) baseById.set(rec.id, rec);
  const localById = new Map<string, MemoryRecord>();
  for (const rec of remappedLocal) localById.set(rec.id, rec);
  const remoteById = new Map<string, MemoryRecord>();
  for (const rec of remote.records) remoteById.set(rec.id, rec);
  const allIds = new Set<string>();
  for (const id of baseById.keys()) allIds.add(id);
  for (const id of localById.keys()) allIds.add(id);
  for (const id of remoteById.keys()) allIds.add(id);
  const mergedList: MemoryRecord[] = [];
  for (const id of allIds) {
    const bRec = baseById.get(id);
    const lRec = localById.get(id);
    const rRec = remoteById.get(id);
    if (lRec !== undefined && rRec !== undefined) {
      const merged = mergeRecordPresentInBothBranches(bRec, lRec, rRec);
      if (merged !== null) {
        mergedList.push(merged);
      }
      continue;
    }
    if (bRec !== undefined && lRec === undefined && rRec !== undefined) {
      if (getRecordTimestampMs(rRec) > getRecordTimestampMs(bRec)) {
        mergedList.push(rRec);
      }
      continue;
    }
    if (bRec !== undefined && lRec !== undefined && rRec === undefined) {
      if (getRecordTimestampMs(lRec) > getRecordTimestampMs(bRec)) {
        mergedList.push(lRec);
      }
      continue;
    }
    if (bRec === undefined && lRec !== undefined) {
      mergedList.push(lRec);
      continue;
    }
    if (bRec === undefined && rRec !== undefined) {
      mergedList.push(rRec);
    }
  }
  const sortedMerged = sortMemoryRecordsCanonically(mergedList);
  const mergedMeta: MemoryMeta = Object.freeze({
    schemaVersion: 1,
    highWaterMarks: Object.freeze({
      R: Math.max(nextFloor.R, maxNumericIdForPrefix(sortedMerged, 'R')),
      L: Math.max(nextFloor.L, maxNumericIdForPrefix(sortedMerged, 'L')),
      N: Math.max(nextFloor.N, maxNumericIdForPrefix(sortedMerged, 'N')),
    }),
  });
  return Object.freeze<ReconciledMemoryLedgerResult>({
    records: sortedMerged,
    meta: mergedMeta,
    idRemap,
  });
}

/**
 * Composes `latestIdRemap` transitively into `cumulativeIdRemap` across push retry iterations (§8.2.3 Step 3).
 *
 * Updates any existing `prevOld -> prevNew` mapping to `prevOld -> (latestIdRemap.get(prevNew) ?? prevNew)`
 * and adds any newly introduced mappings from `latestIdRemap`.
 *
 * @param {Map<string, string>}         cumulativeIdRemap - Mutable cumulative remap table updated in-place.
 * @param {ReadonlyMap<string, string>} latestIdRemap     - Latest single-iteration `idRemap` table.
 *
 * @returns {void}
 */
export function composeCumulativeIdRemap(
  cumulativeIdRemap: Map<string, string>,
  latestIdRemap: ReadonlyMap<string, string>,
): void {
  if (latestIdRemap.size === 0) {
    return;
  }
  for (const [prevOld, prevNew] of cumulativeIdRemap.entries()) {
    const transitiveNew = latestIdRemap.get(prevNew);
    if (transitiveNew !== undefined) {
      cumulativeIdRemap.set(prevOld, transitiveNew);
    }
  }
  for (const [newOld, newTarget] of latestIdRemap.entries()) {
    let alreadyMappedAsIntermediate = false;
    for (const [prevOld, prevNew] of cumulativeIdRemap.entries()) {
      if (prevNew === newTarget && prevOld !== newOld) {
        alreadyMappedAsIntermediate = true;
        break;
      }
    }
    if (!alreadyMappedAsIntermediate && !cumulativeIdRemap.has(newOld)) {
      cumulativeIdRemap.set(newOld, newTarget);
    }
  }
}

/**
 * Applies `idRemap` to an array of record IDs (`seenRecordIds`, `removedIds`, `drainedIds`),
 * deduplicating the resulting IDs while preserving first-seen order.
 *
 * @param {readonly string[]}           recordIds - Input record IDs to remap.
 * @param {ReadonlyMap<string, string>} idRemap   - Mapping from old IDs to re-numbered IDs.
 *
 * @returns {readonly string[]} Frozen array of remapped, deduplicated record IDs.
 */
export function applyIdRemapToRecordIds(
  recordIds: readonly string[],
  idRemap: ReadonlyMap<string, string>,
): readonly string[] {
  if (idRemap.size === 0) {
    return Object.freeze([...recordIds]);
  }
  const seen = new Set<string>();
  const remapped: string[] = [];
  for (const id of recordIds) {
    const mapped = idRemap.get(id) ?? id;
    if (!seen.has(mapped)) {
      seen.add(mapped);
      remapped.push(mapped);
    }
  }
  return Object.freeze(remapped);
}
