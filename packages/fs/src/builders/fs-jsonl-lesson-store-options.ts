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
