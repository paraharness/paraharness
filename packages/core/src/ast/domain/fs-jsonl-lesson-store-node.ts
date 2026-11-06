import type { BaseLessonStoreASTNode } from '../base/base-lesson-store-ast-node.js';

/**
 * Passive AST node configuring a host-root content-addressed JSON/JSONL lesson store (`fs.jsonlLessonStore`).
 *
 * Splits immutable lesson definition files in `definitionsDir` from high-frequency telemetry
 * counters in `statsPath` synchronized via `lockFile`.
 */
export interface FsJsonlLessonStoreNode extends BaseLessonStoreASTNode<'fs:jsonl-lesson-store'> {
  /** Host-root directory storing immutable `<lessonId>.json` definition files. */
  readonly definitionsDir: string;
  /** Host-root file path storing mutable lesson telemetry and outcome counters. */
  readonly statsPath: string;
  /** Host-root advisory lockfile path used for cross-process synchronization. */
  readonly lockFile: string;
}
