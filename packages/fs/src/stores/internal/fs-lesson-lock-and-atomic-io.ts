import { constants, existsSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { FsLessonDefinitionRecord } from './fs-lesson-definition-record.js';
import type { FsLessonStatsEntry } from './fs-lesson-stats-entry.js';

/**
 * Acquires a non-blocking advisory lockfile (`O_CREAT | O_EXCL`) with async backoff and executes `work`.
 *
 * Ensures cross-process serialization on `lockFilePath` without blocking libuv worker threads
 * and unlinks the lockfile in `finally` (`SPEC.md` §4.3).
 *
 * @template TResult Return type of the critical section callback.
 *
 * @param {string}                  lockFilePath - Absolute host-root path to the lockfile.
 * @param {() => Promise<TResult>}  work         - Async operation executed while holding the lock.
 *
 * @returns {Promise<TResult>} Result resolved by `work`.
 */
export async function withNonBlockingAdvisoryFileLock<TResult>(
  lockFilePath: string,
  work: () => Promise<TResult>,
): Promise<TResult> {
  await mkdir(path.dirname(lockFilePath), { recursive: true });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      handle = await open(lockFilePath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
      break;
    } catch (err) {
      const code = (err as { readonly code?: string } | null)?.code;
      if (code !== 'EEXIST') throw err;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, 2 + attempt)));
    }
  }
  if (handle === undefined) {
    throw new Error(`Timed out acquiring advisory lesson lock '${lockFilePath}'.`);
  }
  try {
    await handle.writeFile(`${String(process.pid)}\n`, 'utf8');
    return await work();
  } finally {
    await handle.close();
    await unlink(lockFilePath).catch(() => undefined);
  }
}

/**
 * Writes `payload` as formatted JSON to a temporary sibling file, flushes via `datasync`, and atomically renames to `targetPath`.
 *
 * Guarantees crash-safe atomic updates for both `<definitionsDir>/<lessonId>.json` and `statsPath` (`SPEC.md` §4.3).
 *
 * @param {string}  targetPath - Destination file path.
 * @param {unknown} payload    - JSON-serializable value to write.
 * @param {number}  counter    - Monotonic temp-file suffix counter.
 *
 * @returns {Promise<void>} Resolves once `fsync` and atomic `rename` complete.
 */
export async function atomicWriteJsonFile(
  targetPath: string,
  payload: unknown,
  counter: number,
): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.tmp.${String(process.pid)}.${String(counter)}`;
  const handle = await open(tmpPath, constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY, 0o644);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      await handle.datasync();
    } finally {
      await handle.close();
    }
    await rename(tmpPath, targetPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }
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
