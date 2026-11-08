import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { type FileLockOptions, withFileLock } from '@paraharness/lockfile';
import writeFileAtomic from 'write-file-atomic';
import type { FsLessonDefinitionRecord } from './fs-lesson-definition-record.js';
import type { FsLessonStatsEntry } from './fs-lesson-stats-entry.js';

/**
 * Acquires an exclusive advisory lockfile via `@paraharness/lockfile` and executes `work`.
 *
 * Ensures cross-process and in-process serialization on `lockFilePath` with heartbeat
 * and stale-lock reclamation (`SPEC.md` §4.3).
 *
 * @template TResult Return type of the critical section callback.
 *
 * @param {string}                  lockFilePath - Absolute host-root path to the lockfile.
 * @param {() => Promise<TResult>}  work         - Async operation executed while holding the lock.
 * @param {FileLockOptions}         [options]    - Optional lockfile timing overrides.
 *
 * @returns {Promise<TResult>} Result resolved by `work`.
 */
export function withLessonFileLock<TResult>(
  lockFilePath: string,
  work: () => Promise<TResult>,
  options?: FileLockOptions,
): Promise<TResult> {
  return withFileLock(lockFilePath, work, options);
}

/**
 * Writes `payload` as formatted JSON to `targetPath` atomically via `write-file-atomic`.
 *
 * Guarantees crash-safe atomic updates (`fsync: true` + atomic `rename`) for both
 * `<definitionsDir>/<lessonId>.json` and `statsPath` (`SPEC.md` §4.3).
 *
 * @param {string}  targetPath - Destination file path.
 * @param {unknown} payload    - JSON-serializable value to write.
 *
 * @returns {Promise<void>} Resolves once `fsync` and atomic `rename` complete.
 */
export async function atomicWriteJsonFile(
  targetPath: string,
  payload: unknown,
): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFileAtomic(targetPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
    fsync: true,
  });
}

/**
 * Reads and parses the mutable lesson telemetry map from `statsPath`.
 *
 * Returns a mutable shallow clone of the `lessonId -> FsLessonStatsEntry` dictionary, or an empty object if `statsPath` does not yet exist.
 *
 * @param {string} statsPath - Absolute host-root path to `statsPath`.
 *
 * @returns {Promise<Record<string, FsLessonStatsEntry>>} Parsed per-lesson telemetry counter map.
 */
export async function readLessonStatsFile(
  statsPath: string,
): Promise<Record<string, FsLessonStatsEntry>> {
  if (!existsSync(statsPath)) {
    return {};
  }
  const raw = await readFile(statsPath, 'utf8');
  if (raw.trim().length === 0) {
    return {};
  }
  const parsed = JSON.parse(raw) as Readonly<Record<string, FsLessonStatsEntry>>;
  return { ...parsed };
}

/**
 * Reads all immutable `<lessonId>.json` definition files from `definitionsDir` in lexicographical filename order.
 *
 * Skips temporary `.tmp.` files and returns an empty array if `definitionsDir` does not yet exist.
 *
 * @param {string} definitionsDir - Absolute host-root path to `definitionsDir`.
 *
 * @returns {Promise<readonly FsLessonDefinitionRecord[]>} Frozen array of parsed lesson definitions.
 */
export async function readAllLessonDefinitions(
  definitionsDir: string,
): Promise<readonly FsLessonDefinitionRecord[]> {
  if (!existsSync(definitionsDir)) {
    return Object.freeze([]);
  }
  const entries = await readdir(definitionsDir);
  const jsonFiles: string[] = [];
  for (const fileName of entries) {
    if (fileName.endsWith('.json') && !fileName.includes('.tmp.')) {
      jsonFiles.push(fileName);
    }
  }
  jsonFiles.sort((a, b) => a.localeCompare(b));
  const definitions: FsLessonDefinitionRecord[] = [];
  for (const fileName of jsonFiles) {
    const raw = await readFile(path.join(definitionsDir, fileName), 'utf8');
    definitions.push(JSON.parse(raw) as FsLessonDefinitionRecord);
  }
  return Object.freeze(definitions);
}
