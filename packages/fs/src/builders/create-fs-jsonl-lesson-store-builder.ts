import type { FsJsonlLessonStoreNode } from '@metaharness/core';

/**
 * Configuration options for `fs.jsonlLessonStore(options)`.
 *
 * Configures the host-root directory for immutable content-addressed lesson JSON files,
 * the mutable telemetry counter file path, and the advisory lockfile path.
 */
export interface FsJsonlLessonStoreOptions {
  /** Host-root directory storing immutable `<lessonId>.json` definition files. */
  readonly definitionsDir: string;
  /** Host-root file path storing mutable lesson telemetry and outcome counters. */
  readonly statsPath: string;
  /** Host-root advisory lockfile path used for cross-process synchronization. */
  readonly lockFile: string;
}

/**
 * Compiles a passive `FsJsonlLessonStoreNode` (`fs:jsonl-lesson-store`) for `fs.jsonlLessonStore(options)`.
 *
 * Configures a host-root-resolved content-addressed lesson store splitting immutable
 * `<definitionsDir>/<lessonId>.json` definitions from mutable `statsPath` counters.
 *
 * @param {FsJsonlLessonStoreOptions} options - Host-root paths for definitions, stats, and lockfile.
 *
 * @returns {FsJsonlLessonStoreNode} Deeply frozen `FsJsonlLessonStoreNode` AST descriptor.
 *
 * @throws {Error} If any of `definitionsDir`, `statsPath`, or `lockFile` is empty.
 */
export function createFsJsonlLessonStoreBuilder(
  options: FsJsonlLessonStoreOptions,
): FsJsonlLessonStoreNode {
  if (typeof options.definitionsDir !== 'string' || options.definitionsDir.trim().length === 0) {
    throw new Error('fs.jsonlLessonStore requires a non-empty definitionsDir path.');
  }
  if (typeof options.statsPath !== 'string' || options.statsPath.trim().length === 0) {
    throw new Error('fs.jsonlLessonStore requires a non-empty statsPath.');
  }
  if (typeof options.lockFile !== 'string' || options.lockFile.trim().length === 0) {
    throw new Error('fs.jsonlLessonStore requires a non-empty lockFile path.');
  }
  return Object.freeze<FsJsonlLessonStoreNode>({
    type: 'fs:jsonl-lesson-store',
    definitionsDir: options.definitionsDir.trim(),
    statsPath: options.statsPath.trim(),
    lockFile: options.lockFile.trim(),
  });
}
