import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import type { MemoryMeta, MemoryRecord } from '../schemas/memory-record.schema.js';
import { MEMORY_META_FILENAME } from './memory-protocol.constants.js';
import { reconcileMetaHighWaterMarks } from './read-memory-ledger.js';
import {
  parseRecordNumericId,
  sortMemoryRecordsCanonically,
} from './sort-memory-records-canonically.js';

/**
 * Parameter object for `writeMemoryLedger`.
 */
export interface WriteMemoryLedgerParams {
  /** Filesystem path to `memory.jsonl`. */
  readonly ledgerPath: string;
  /** Active records to persist in canonical order (`R*` -> `L*` -> `N*`). */
  readonly records: readonly MemoryRecord[];
  /** Optional `MemoryMeta` whose `highWaterMarks` will be reconciled with `records`. */
  readonly meta?: MemoryMeta;
  /** Whether to atomically persist `memory.meta.json` in Step 1 (`defaults to true`). */
  readonly writeMeta?: boolean;
  /** Whether to atomically persist `memory.jsonl` in Step 2 (`defaults to true`). */
  readonly writeLedger?: boolean;
}

/**
 * Allocates the next monotonic record ID (`R<n>`, `L<n>`, or `N<n>`) for `prefix` across `meta`
 * and `records` without ever reusing deleted or drained IDs (§3.1).
 *
 * @param {MemoryMeta}              meta    - Current monotonic high-water-mark metadata.
 * @param {readonly MemoryRecord[]} records - Current records in `memory.jsonl`.
 * @param {'R' | 'L' | 'N'}         prefix  - Record ID prefix (`'R'`, `'L'`, or `'N'`).
 *
 * @returns {{ readonly id: string; readonly meta: MemoryMeta }} Newly allocated ID and updated `MemoryMeta`.
 */
export function allocateNextMemoryRecordId(
  meta: MemoryMeta,
  records: readonly MemoryRecord[],
  prefix: 'R' | 'L' | 'N',
): { readonly id: string; readonly meta: MemoryMeta } {
  let effectiveMax = meta.highWaterMarks[prefix];
  for (const record of records) {
    if (record.id.startsWith(prefix)) {
      const numericId = parseRecordNumericId(record.id);
      if (Number.isInteger(numericId) && numericId > effectiveMax) {
        effectiveMax = numericId;
      }
    }
  }
  const nextNumeric = effectiveMax + 1;
  const nextMarks = Object.freeze({
    R: prefix === 'R' ? nextNumeric : meta.highWaterMarks.R,
    L: prefix === 'L' ? nextNumeric : meta.highWaterMarks.L,
    N: prefix === 'N' ? nextNumeric : meta.highWaterMarks.N,
  });
  return Object.freeze({
    id: `${prefix}${nextNumeric}`,
    meta: Object.freeze<MemoryMeta>({
      schemaVersion: 1,
      highWaterMarks: nextMarks,
    }),
  });
}

/**
 * Serializes canonically sorted `MemoryRecord` entries into UTF-8 JSON Lines text.
 *
 * @param {readonly MemoryRecord[]} sortedRecords - Canonically sorted records.
 *
 * @returns {string} Serialized JSONL content (empty string when `sortedRecords` is empty).
 */
export function serializeMemoryRecordsJsonl(sortedRecords: readonly MemoryRecord[]): string {
  if (sortedRecords.length === 0) {
    return '';
  }
  const lines: string[] = [];
  for (const record of sortedRecords) {
    lines.push(JSON.stringify(record));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Canonically sorts `params.records` (`R*` -> `L*` -> `N*`, ascending numeric ID), reconciles
 * `memory.meta.json` `highWaterMarks`, and atomically persists `memory.meta.json` **first** and
 * `memory.jsonl` **second** via `write-file-atomic` (§3.1, §8.1 Rule 2).
 *
 * @param {WriteMemoryLedgerParams} params - Target `ledgerPath`, `records`, `meta`, and write flags.
 *
 * @returns {Promise<{ readonly records: readonly MemoryRecord[]; readonly meta: MemoryMeta }>} Canonically sorted records and reconciled metadata written to disk.
 */
export async function writeMemoryLedger(params: WriteMemoryLedgerParams): Promise<{
  readonly records: readonly MemoryRecord[];
  readonly meta: MemoryMeta;
}> {
  const absLedgerPath = path.resolve(params.ledgerPath);
  const ledgerDir = path.dirname(absLedgerPath);
  const metaPath = path.join(ledgerDir, MEMORY_META_FILENAME);
  await mkdir(ledgerDir, { recursive: true });
  const baseMeta: MemoryMeta = params.meta ?? {
    schemaVersion: 1,
    highWaterMarks: { R: 0, L: 0, N: 0 },
  };
  const sortedRecords = sortMemoryRecordsCanonically(params.records);
  const reconciledMeta = reconcileMetaHighWaterMarks(baseMeta, sortedRecords);
  if (params.writeMeta !== false) {
    const serializedMeta = `${JSON.stringify(reconciledMeta, null, 2)}\n`;
    await writeFileAtomic(metaPath, serializedMeta, { encoding: 'utf8' });
  }
  if (params.writeLedger !== false) {
    const serializedLedger = serializeMemoryRecordsJsonl(sortedRecords);
    await writeFileAtomic(absLedgerPath, serializedLedger, { encoding: 'utf8' });
  }
  return Object.freeze({
    records: sortedRecords,
    meta: reconciledMeta,
  });
}
