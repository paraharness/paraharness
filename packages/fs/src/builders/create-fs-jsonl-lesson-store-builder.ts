import type { FsJsonlLessonStoreNode } from '@harness-dsl/core';
import type { FsJsonlLessonStoreOptions } from './fs-jsonl-lesson-store-options.js';

/**
 * Compiles a passive `FsJsonlLessonStoreNode` (`fs:jsonl-lesson-store`) for `fs.jsonlLessonStore(options)`.
 *
 * Configures a host-root-resolved content-addressed lesson store splitting immutable
 * `<definitionsDir>/<lessonId>.json` definitions from mutable `statsPath` counters.
 *
 * @param {FsJsonlLessonStoreOptions} options - Host-root paths for definitions, stats, and lockfile.
 *
 * @returns {FsJsonlLessonStoreNode} Deeply frozen `FsJsonlLessonStoreNode` AST descriptor.
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
