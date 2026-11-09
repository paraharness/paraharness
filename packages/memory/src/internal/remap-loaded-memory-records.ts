import type {
  MemoryLessonRecord,
  MemoryRecord,
  MemoryRuleRecord,
} from '../schemas/memory-record.schema.js';
import type { MemoryLoadedNoteRecord } from '../schemas/memory-tools.schema.js';
import {
  parseRecordNumericId,
  sortMemoryRecordsCanonically,
} from './sort-memory-records-canonically.js';

/**
 * Parameter object for `remapLoadedMemoryRecords`.
 */
export interface RemapLoadedMemoryRecordsParams {
  /** Rule records returned by the read operation. */
  readonly rules: readonly MemoryRuleRecord[];
  /** Lesson records returned by the read operation. */
  readonly lessons: readonly MemoryLessonRecord[];
  /** Loaded note records returned by the read operation. */
  readonly notes: readonly MemoryLoadedNoteRecord[];
  /** Transitive ID remapping (`oldId -> newId`) produced by Git reconciliation. */
  readonly idRemap: ReadonlyMap<string, string>;
}

/**
 * Applies `idRemap` to a single `MemoryRecord` when its `id` was re-numbered during Git reconciliation.
 *
 * @template T Record subtype extending `MemoryRecord`.
 *
 * @param {T}                           record  - Record to inspect and remap.
 * @param {ReadonlyMap<string, string>} idRemap - Mapping from old IDs to re-numbered IDs.
 *
 * @returns {T} Original or re-numbered frozen record.
 */
export function remapSingleMemoryRecord<T extends MemoryRecord>(
  record: T,
  idRemap: ReadonlyMap<string, string>,
): T {
  const mappedId = idRemap.get(record.id);
  if (mappedId === undefined || mappedId === record.id) {
    return record;
  }
  return Object.freeze<T>({
    ...record,
    id: mappedId,
  });
}

/**
 * Applies `idRemap` to a single `MemoryLoadedNoteRecord` when its `id` was re-numbered.
 *
 * @param {MemoryLoadedNoteRecord}      note    - Loaded note record to inspect and remap.
 * @param {ReadonlyMap<string, string>} idRemap - Mapping from old IDs to re-numbered IDs.
 *
 * @returns {MemoryLoadedNoteRecord} Original or re-numbered frozen loaded note record.
 */
export function remapSingleLoadedNoteRecord(
  note: MemoryLoadedNoteRecord,
  idRemap: ReadonlyMap<string, string>,
): MemoryLoadedNoteRecord {
  const mappedId = idRemap.get(note.id);
  if (mappedId === undefined || mappedId === note.id) {
    return note;
  }
  return Object.freeze<MemoryLoadedNoteRecord>({
    ...note,
    id: mappedId,
  });
}

/**
 * Applies `params.idRemap` to `rules`, `lessons`, and `notes` arrays and sorts each array by
 * ascending numeric ID per §1.2 and §8.2.3 Step 3.
 *
 * @param {RemapLoadedMemoryRecordsParams} params - Rules, lessons, notes, and `idRemap` table.
 *
 * @returns {{ readonly rules: readonly MemoryRuleRecord[]; readonly lessons: readonly MemoryLessonRecord[]; readonly notes: readonly MemoryLoadedNoteRecord[] }} Remapped and canonically sorted record lists.
 */
export function remapLoadedMemoryRecords(params: RemapLoadedMemoryRecordsParams): {
  readonly rules: readonly MemoryRuleRecord[];
  readonly lessons: readonly MemoryLessonRecord[];
  readonly notes: readonly MemoryLoadedNoteRecord[];
} {
  if (params.idRemap.size === 0) {
    return Object.freeze({
      rules: sortMemoryRecordsCanonically(params.rules),
      lessons: sortMemoryRecordsCanonically(params.lessons),
      notes: Object.freeze(
        [...params.notes].sort(
          (left, right) => parseRecordNumericId(left.id) - parseRecordNumericId(right.id),
        ),
      ),
    });
  }
  const remappedRules: MemoryRuleRecord[] = [];
  for (const rule of params.rules) {
    remappedRules.push(remapSingleMemoryRecord(rule, params.idRemap));
  }
  const remappedLessons: MemoryLessonRecord[] = [];
  for (const lesson of params.lessons) {
    remappedLessons.push(remapSingleMemoryRecord(lesson, params.idRemap));
  }
  const remappedNotes: MemoryLoadedNoteRecord[] = [];
  for (const note of params.notes) {
    remappedNotes.push(remapSingleLoadedNoteRecord(note, params.idRemap));
  }
  remappedNotes.sort(
    (left, right) => parseRecordNumericId(left.id) - parseRecordNumericId(right.id),
  );
  return Object.freeze({
    rules: sortMemoryRecordsCanonically(remappedRules),
    lessons: sortMemoryRecordsCanonically(remappedLessons),
    notes: Object.freeze(remappedNotes),
  });
}
