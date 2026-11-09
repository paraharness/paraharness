import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  MemoryRecordSchema,
  type MemoryMeta,
  type MemoryRecord,
} from '../schemas/memory-record.schema.js';
import { execGitCommand } from './exec-git-command.js';
import { GIT_LOG_ID_MATCH_REGEX } from './memory-protocol.constants.js';
import { parseRecordNumericId } from './sort-memory-records-canonically.js';

/**
 * Updates `marks` in-place with the maximum numeric IDs observed across `records`.
 *
 * @param {{ R: number; L: number; N: number }} marks   - Mutable high-water-mark accumulator.
 * @param {readonly MemoryRecord[]}             records - Records to scan for ID prefixes and numbers.
 *
 * @returns {void}
 */
function accumulateHighWaterMarksFromRecords(
  marks: { R: number; L: number; N: number },
  records: readonly MemoryRecord[],
): void {
  for (const record of records) {
    const prefix = record.id[0];
    const numericId = parseRecordNumericId(record.id);
    if (
      (prefix === 'R' || prefix === 'L' || prefix === 'N') &&
      Number.isInteger(numericId) &&
      numericId > marks[prefix]
    ) {
      marks[prefix] = numericId;
    }
  }
}

/**
 * Updates `marks` in-place with the maximum numeric IDs matched across `git log -p -S '"id":"'` output.
 *
 * @param {{ R: number; L: number; N: number }} marks  - Mutable high-water-mark accumulator.
 * @param {string}                              stdout - Standard output captured from `git log -p -S`.
 *
 * @returns {void}
 */
function accumulateHighWaterMarksFromGitLogOutput(
  marks: { R: number; L: number; N: number },
  stdout: string,
): void {
  for (const match of stdout.matchAll(GIT_LOG_ID_MATCH_REGEX)) {
    const prefix = match[1];
    const numStr = match[2];
    const numericId = numStr !== undefined ? Number(numStr) : Number.NaN;
    if (
      (prefix === 'R' || prefix === 'L' || prefix === 'N') &&
      Number.isInteger(numericId) &&
      numericId > marks[prefix]
    ) {
      marks[prefix] = numericId;
    }
  }
}

/**
 * Reads raw `MemoryRecord` entries from `absLedgerPath` if the file exists on disk.
 *
 * @param {string} absLedgerPath - Absolute path to `memory.jsonl`.
 *
 * @returns {readonly MemoryRecord[]} Parsed records, or `[]` if absent or unreadable.
 */
function readRawRecordsIfPresent(absLedgerPath: string): readonly MemoryRecord[] {
  if (!existsSync(absLedgerPath)) {
    return [];
  }
  try {
    const content = readFileSync(absLedgerPath, 'utf8');
    const records: MemoryRecord[] = [];
    for (const rawLine of content.split('\n')) {
      const trimmed = rawLine.trim();
      if (trimmed.length === 0) continue;
      const parsed = MemoryRecordSchema.safeParse(JSON.parse(trimmed));
      if (parsed.success) {
        records.push(parsed.data);
      }
    }
    return records;
  } catch {
    return [];
  }
}

/**
 * Scans `git log -p -S '"id":"' -- <ledgerPath>` on first-run `memory.meta.json` creation when
 * inside a Git checkout with prior history, combining discovered historical high-water marks with
 * current raw `memory.jsonl` records (§3.1).
 *
 * @param {string}                  ledgerPath   - Path to `memory.jsonl`.
 * @param {readonly MemoryRecord[]} [rawRecords] - Optional pre-loaded raw records from `memory.jsonl`.
 *
 * @returns {Promise<MemoryMeta>} Initialized `MemoryMeta` with monotonic `highWaterMarks`.
 */
export async function initializeMetaFromGitHistory(
  ledgerPath: string,
  rawRecords?: readonly MemoryRecord[],
): Promise<MemoryMeta> {
  const absLedgerPath = path.resolve(ledgerPath);
  const ledgerDir = path.dirname(absLedgerPath);
  const marks = { R: 0, L: 0, N: 0 };
  const initialRecords = rawRecords ?? readRawRecordsIfPresent(absLedgerPath);
  accumulateHighWaterMarksFromRecords(marks, initialRecords);
  if (!existsSync(ledgerDir)) {
    return Object.freeze<MemoryMeta>({
      schemaVersion: 1,
      highWaterMarks: Object.freeze({ R: marks.R, L: marks.L, N: marks.N }),
    });
  }
  const check = await execGitCommand({
    cwd: ledgerDir,
    args: ['rev-parse', '--is-inside-work-tree'],
  });
  if (check.exitCode !== 0 || check.stdout.trim() !== 'true') {
    return Object.freeze<MemoryMeta>({
      schemaVersion: 1,
      highWaterMarks: Object.freeze({ R: marks.R, L: marks.L, N: marks.N }),
    });
  }
  const logResult = await execGitCommand({
    cwd: ledgerDir,
    args: ['log', '-p', '-S', '"id":"', '--', absLedgerPath],
  });
  if (logResult.exitCode === 0 && logResult.stdout.length > 0) {
    accumulateHighWaterMarksFromGitLogOutput(marks, logResult.stdout);
  }
  return Object.freeze<MemoryMeta>({
    schemaVersion: 1,
    highWaterMarks: Object.freeze({
      R: marks.R,
      L: marks.L,
      N: marks.N,
    }),
  });
}
