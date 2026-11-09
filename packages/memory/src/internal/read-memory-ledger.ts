import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { MemoryHarnessError } from '../memory-harness-error.js';
import {
  MemoryMetaSchema,
  MemoryRecordSchema,
  type MemoryMeta,
  type MemoryRecord,
} from '../schemas/memory-record.schema.js';
import { initializeMetaFromGitHistory } from './initialize-meta-from-git-history.js';
import type { MemoryLedgerSnapshot } from './memory-ledger-snapshot.js';
import { MEMORY_META_FILENAME } from './memory-protocol.constants.js';
import {
  parseRecordNumericId,
  sortMemoryRecordsCanonically,
} from './sort-memory-records-canonically.js';

/**
 * Parses a JSONL string into validated `MemoryRecord` objects.
 *
 * @param {string} jsonlText     - UTF-8 contents of `memory.jsonl`.
 * @param {string} absLedgerPath - Ledger file path for error attribution.
 *
 * @returns {readonly MemoryRecord[]} Frozen array of raw validated records.
 *
 * @throws {MemoryHarnessError} With `'VALIDATION_FAILED'` if any non-empty line is invalid JSON or fails `MemoryRecordSchema`.
 */
export function parseMemoryLedgerJsonl(
  jsonlText: string,
  absLedgerPath = '<memory.jsonl>',
): readonly MemoryRecord[] {
  const records: MemoryRecord[] = [];
  const lines = jsonlText.split('\n');
  for (let idx = 0; idx < lines.length; idx += 1) {
    const rawLine = lines[idx];
    if (rawLine === undefined) continue;
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) continue;
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(trimmed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new MemoryHarnessError(
        'VALIDATION_FAILED',
        `Malformed JSON at line ${idx + 1} of '${absLedgerPath}': ${message}`,
        { ledgerPath: absLedgerPath, line: idx + 1 },
      );
    }
    const validated = MemoryRecordSchema.safeParse(parsedJson);
    if (!validated.success) {
      throw new MemoryHarnessError(
        'VALIDATION_FAILED',
        `Invalid memory record at line ${idx + 1} of '${absLedgerPath}': ${validated.error.message}`,
        { ledgerPath: absLedgerPath, line: idx + 1, issues: validated.error.issues },
      );
    }
    records.push(validated.data);
  }
  return Object.freeze(records);
}

/**
 * Computes the reconciled monotonic `MemoryMeta` across `baseMeta` and `records` (§3.1).
 *
 * @param {MemoryMeta}              baseMeta - Starting `MemoryMeta` object.
 * @param {readonly MemoryRecord[]} records  - Records whose numeric IDs must be covered by `highWaterMarks`.
 *
 * @returns {MemoryMeta} Frozen `MemoryMeta` with monotonic high-water marks.
 */
export function reconcileMetaHighWaterMarks(
  baseMeta: MemoryMeta,
  records: readonly MemoryRecord[],
): MemoryMeta {
  let maxR = baseMeta.highWaterMarks.R;
  let maxL = baseMeta.highWaterMarks.L;
  let maxN = baseMeta.highWaterMarks.N;
  for (const record of records) {
    const numericId = parseRecordNumericId(record.id);
    if (!Number.isInteger(numericId)) continue;
    if (record.type === 'rule' && numericId > maxR) maxR = numericId;
    else if (record.type === 'lesson' && numericId > maxL) maxL = numericId;
    else if (record.type === 'note' && numericId > maxN) maxN = numericId;
  }
  return Object.freeze<MemoryMeta>({
    schemaVersion: 1,
    highWaterMarks: Object.freeze({
      R: maxR,
      L: maxL,
      N: maxN,
    }),
  });
}

/**
 * Reads `memory.jsonl` and `memory.meta.json` (initializing `memory.meta.json` via
 * `initializeMetaFromGitHistory` when absent), reconciles monotonic `highWaterMarks` across all
 * raw records **before** expiry, and purges expired `hard-expiry` notes at `nowMs` (§3.1, §3.3).
 *
 * @param {string} ledgerPath         - Filesystem path to `memory.jsonl`.
 * @param {number} [nowMs=Date.now()] - Current UTC epoch milliseconds used for `hard-expiry` checks.
 *
 * @returns {Promise<MemoryLedgerSnapshot>} Reconciled ledger and metadata snapshot.
 *
 * @throws {MemoryHarnessError} With `'VALIDATION_FAILED'` if `memory.jsonl` or `memory.meta.json` is corrupted.
 */
export async function readMemoryLedger(
  ledgerPath: string,
  nowMs: number = Date.now(),
): Promise<MemoryLedgerSnapshot> {
  const absLedgerPath = path.resolve(ledgerPath);
  const metaPath = path.join(path.dirname(absLedgerPath), MEMORY_META_FILENAME);
  const ledgerExisted = existsSync(absLedgerPath);
  const rawRecords = ledgerExisted
    ? parseMemoryLedgerJsonl(await readFile(absLedgerPath, 'utf8'), absLedgerPath)
    : Object.freeze<MemoryRecord[]>([]);
  const metaExisted = existsSync(metaPath);
  let initialMeta: MemoryMeta;
  if (metaExisted) {
    let rawMetaJson: unknown;
    try {
      rawMetaJson = JSON.parse(await readFile(metaPath, 'utf8'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new MemoryHarnessError(
        'VALIDATION_FAILED',
        `Malformed JSON in '${metaPath}': ${message}`,
        { metaPath },
      );
    }
    const parsedMeta = MemoryMetaSchema.safeParse(rawMetaJson);
    if (!parsedMeta.success) {
      throw new MemoryHarnessError(
        'VALIDATION_FAILED',
        `Invalid memory metadata in '${metaPath}': ${parsedMeta.error.message}`,
        { metaPath, issues: parsedMeta.error.issues },
      );
    }
    initialMeta = parsedMeta.data;
  } else {
    initialMeta = await initializeMetaFromGitHistory(absLedgerPath, rawRecords);
  }
  const reconciledMeta = reconcileMetaHighWaterMarks(initialMeta, rawRecords);
  const marksAdvanced =
    reconciledMeta.highWaterMarks.R > initialMeta.highWaterMarks.R ||
    reconciledMeta.highWaterMarks.L > initialMeta.highWaterMarks.L ||
    reconciledMeta.highWaterMarks.N > initialMeta.highWaterMarks.N;
  const hasAnyMark =
    reconciledMeta.highWaterMarks.R > 0 ||
    reconciledMeta.highWaterMarks.L > 0 ||
    reconciledMeta.highWaterMarks.N > 0;
  const metaNeedsWrite =
    marksAdvanced || (!metaExisted && (ledgerExisted || hasAnyMark));
  const activeRecords: MemoryRecord[] = [];
  const purgedExpiredNoteIds: string[] = [];
  for (const record of rawRecords) {
    if (
      record.type === 'note' &&
      record.lifecycle.mode === 'hard-expiry' &&
      nowMs >= Date.parse(record.lifecycle.expiresAt)
    ) {
      purgedExpiredNoteIds.push(record.id);
      continue;
    }
    activeRecords.push(record);
  }
  const sortedActive = sortMemoryRecordsCanonically(activeRecords);
  return Object.freeze<MemoryLedgerSnapshot>({
    records: sortedActive,
    rawRecords,
    meta: reconciledMeta,
    ledgerExisted,
    metaExisted,
    metaNeedsWrite,
    purgedExpiredNoteIds: Object.freeze(purgedExpiredNoteIds),
    ledgerNeedsWrite: purgedExpiredNoteIds.length > 0,
  });
}
