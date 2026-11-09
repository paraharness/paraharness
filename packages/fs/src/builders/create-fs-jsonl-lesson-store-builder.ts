import type { FsJsonlLessonStoreNode } from '@paraharness/core';

/**
 * Configuration options for `fs.jsonlLessonStore(options?)`.
 *
 * Configures the host-root directory for immutable content-addressed lesson JSON files,
 * the mutable telemetry counter file path, and the advisory lockfile path.
 */
export interface FsJsonlLessonStoreOptions {
  /** Host-root directory storing immutable `<lessonId>.json` definition files (defaults to `'.paraharness/lessons'`). */
  readonly definitionsDir?: string;
  /** Host-root file path storing mutable lesson telemetry and outcome counters (defaults to `` `${definitionsDir}-stats.json` ``). */
  readonly statsPath?: string;
  /** Host-root advisory lockfile path used for cross-process synchronization (defaults to `` `${definitionsDir}.lock` ``). */
  readonly lockFile?: string;
}

/**
 * Compiles a passive `FsJsonlLessonStoreNode` (`fs:jsonl-lesson-store`) for `fs.jsonlLessonStore(options?)`.
 *
 * Configures a host-root-resolved content-addressed lesson store splitting immutable
 * `<definitionsDir>/<lessonId>.json` definitions from mutable `statsPath` counters.
 *
 * @param {FsJsonlLessonStoreOptions} [options] - Optional host-root paths for definitions, stats, and lockfile.
 *
 * @returns {FsJsonlLessonStoreNode} Deeply frozen `FsJsonlLessonStoreNode` AST descriptor.
 *
 * @throws {Error} If any of `definitionsDir`, `statsPath`, or `lockFile` is empty.
 */
export function createFsJsonlLessonStoreBuilder(
  options?: FsJsonlLessonStoreOptions,
): FsJsonlLessonStoreNode {
  if (
    options?.definitionsDir !== undefined &&
    (typeof options.definitionsDir !== 'string' || options.definitionsDir.trim().length === 0)
  ) {
    throw new Error('fs.jsonlLessonStore requires a non-empty definitionsDir path.');
  }
  if (
    options?.statsPath !== undefined &&
    (typeof options.statsPath !== 'string' || options.statsPath.trim().length === 0)
  ) {
    throw new Error('fs.jsonlLessonStore requires a non-empty statsPath.');
  }
  if (
    options?.lockFile !== undefined &&
    (typeof options.lockFile !== 'string' || options.lockFile.trim().length === 0)
  ) {
    throw new Error('fs.jsonlLessonStore requires a non-empty lockFile path.');
  }
  const definitionsDir = (options?.definitionsDir ?? '.paraharness/lessons').trim();
  const normalizedBase = definitionsDir.replace(/[/\\]+$/, '') || '.paraharness/lessons';
  const statsPath = (options?.statsPath ?? `${normalizedBase}-stats.json`).trim();
  const lockFile = (options?.lockFile ?? `${normalizedBase}.lock`).trim();
  return Object.freeze<FsJsonlLessonStoreNode>({
    type: 'fs:jsonl-lesson-store',
    definitionsDir,
    statsPath,
    lockFile,
  });
}
