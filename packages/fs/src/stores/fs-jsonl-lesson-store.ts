import path from 'node:path';
import type {
  FsJsonlLessonStoreNode,
  LessonOutcome,
  LessonRecord,
  LessonStore,
} from '@harness-dsl/core';
import PQueue from 'p-queue';
import {
  admitLessonToStore,
  markLessonSignalEmittedInStore,
  queryActiveLessonCandidates,
  recordLessonOutcomesInStore,
  retireLessonsInStore,
  syncLessonCreationEpochsInStore,
} from './internal/fs-jsonl-lesson-file-io.js';
import { withLessonFileLock } from './internal/fs-lesson-lock-and-atomic-io.js';

/**
 * Query parameters for {@link FsJsonlLessonStore.queryCandidates}.
 */
export interface FsQueryCandidatesParams {
  /** Search query text extracted from actor input. */
  readonly queryText: string;

  /** Active task partitions. */
  readonly partitions: readonly string[];
}

/**
 * Admission parameters for {@link FsJsonlLessonStore.admit}.
 */
export interface FsAdmitLessonParams {
  /** Optional topology partition identifier. */
  readonly partition?: string;

  /** Preventative or prescriptive directive text. */
  readonly directive: string;

  /** Partition contract epoch at creation. */
  readonly epochAtCreation: number;

  /** Optional run identifier that admitted the lesson. */
  readonly createdByRunId?: string;
}

/**
 * Single lesson outcome entry for {@link FsJsonlLessonStore.recordOutcomes}.
 */
export interface FsRecordOutcomeParams {
  /** Target lesson identifier. */
  readonly lessonId: string;

  /** Recorded execution outcome (`'clean_pass'` or `'violated'`). */
  readonly outcome: LessonOutcome;
}

/**
 * Crash-safe hybrid filesystem `LessonStore` implementation (`fs.jsonlLessonStore`, `SPEC.md` §4.3).
 *
 * Resolves `definitionsDir`, `statsPath`, and `lockFile` against the immutable host repository
 * root (Invariant 5), writes immutable `<definitionsDir>/<lessonId>.json` definition files on
 * `admit()`, and updates mutable telemetry counters in `statsPath` under a `PQueue({ concurrency: 1 })`
 * queue combined with `@harness-dsl/lockfile` and `write-file-atomic`.
 */
export class FsJsonlLessonStore implements LessonStore {
  /** Absolute host-root directory path storing immutable `<lessonId>.json` definitions. */
  private readonly definitionsDirPath: string;
  /** Absolute host-root file path storing mutable lesson telemetry counters. */
  private readonly statsFilePath: string;
  /** Absolute host-root advisory lockfile path. */
  private readonly lockFilePath: string;
  /** Serialized in-process async mutex queue (`concurrency: 1`). */
  private readonly mutexQueue = new PQueue({ concurrency: 1 });

  /**
   * Initializes an `FsJsonlLessonStore` bound to the host repository root (`SPEC.md` Invariant 5).
   *
   * Resolves all configured store paths relative to `hostRoot` (defaulting to `process.cwd()`).
   *
   * @param {FsJsonlLessonStoreNode} node                     - Passive lesson store AST node.
   * @param {string}                 [hostRoot=process.cwd()] - Optional explicit host repository root directory.
   */
  constructor(node: FsJsonlLessonStoreNode, hostRoot: string = process.cwd()) {
    const resolvedRoot = path.resolve(hostRoot);
    this.definitionsDirPath = path.resolve(resolvedRoot, node.definitionsDir);
    this.statsFilePath = path.resolve(resolvedRoot, node.statsPath);
    this.lockFilePath = path.resolve(resolvedRoot, node.lockFile);
  }

  /**
   * Enqueues `operation` onto the in-process `PQueue` (`concurrency: 1`) and acquires the advisory file lock.
   *
   * Guarantees strict serialization across concurrent calls within the process and across processes.
   *
   * @template TResult Result type of the locked operation.
   *
   * @param {() => Promise<TResult>} operation - Critical section callback.
   *
   * @returns {Promise<TResult>} Result returned by `operation`.
   */
  private enqueueLocked<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    return this.mutexQueue.add(() => withLessonFileLock(this.lockFilePath, operation));
  }

  /**
   * Queries non-retired candidate lessons and populates `relevanceScore` in `[0, 1]` via `MiniSearch`.
   *
   * Orders returned candidate lessons deterministically by descending `relevanceScore` and `id`.
   *
   * @param {FsQueryCandidatesParams} req - Query text and active partitions.
   *
   * @returns {Promise<readonly LessonRecord[]>} Frozen array of candidate lesson records.
   */
  queryCandidates(req: FsQueryCandidatesParams): Promise<readonly LessonRecord[]> {
    return this.enqueueLocked(() =>
      queryActiveLessonCandidates({
        definitionsDirPath: this.definitionsDirPath,
        statsFilePath: this.statsFilePath,
        queryText: req.queryText,
        partitions: req.partitions,
      }),
    );
  }

  /**
   * Admits a distilled lesson by writing an immutable `<definitionsDir>/<lessonId>.json` file.
   *
   * Deduplicates identical `(partition, directive)` pairs and initializes telemetry counters in `statsPath`.
   *
   * @param {FsAdmitLessonParams} lesson - Lesson definition to admit.
   *
   * @returns {Promise<string>} Assigned content-addressed `lessonId`.
   */
  admit(lesson: FsAdmitLessonParams): Promise<string> {
    return this.enqueueLocked(() =>
      admitLessonToStore({
        definitionsDirPath: this.definitionsDirPath,
        statsFilePath: this.statsFilePath,
        partition: lesson.partition,
        directive: lesson.directive,
        epochAtCreation: lesson.epochAtCreation,
        createdByRunId: lesson.createdByRunId,
      }),
    );
  }

  /**
   * Appends deduplicated step execution outcomes to `statsPath` and returns the updated lesson records.
   *
   * Increments `totalCleanPasses` and `totalViolated` counters without touching `<definitionsDir>/<lessonId>.json`.
   *
   * @param {readonly FsRecordOutcomeParams[]} outcomes - Batch of lesson outcomes.
   *
   * @returns {Promise<readonly LessonRecord[]>} Updated lesson records for the affected lessons.
   */
  recordOutcomes(outcomes: readonly FsRecordOutcomeParams[]): Promise<readonly LessonRecord[]> {
    return this.enqueueLocked(() =>
      recordLessonOutcomesInStore({
        definitionsDirPath: this.definitionsDirPath,
        statsFilePath: this.statsFilePath,
        outcomes,
      }),
    );
  }

  /**
   * Aligns `epochAtCreation` overrides in `statsPath` for lessons created by `runIds`.
   *
   * Keeps `<definitionsDir>/<lessonId>.json` 100% immutable while updating `statsPath` (`SPEC.md` §4.3).
   *
   * @param {readonly string[]}           runIds        - Run IDs whose topology overlays committed.
   * @param {ReadonlyMap<string, number>} updatedEpochs - Map of `partitionId` to committed base epoch.
   *
   * @returns {Promise<void>} Resolves when `statsPath` is atomically updated.
   */
  syncCreationEpochsForRuns(
    runIds: readonly string[],
    updatedEpochs: ReadonlyMap<string, number>,
  ): Promise<void> {
    return this.enqueueLocked(() =>
      syncLessonCreationEpochsInStore({
        definitionsDirPath: this.definitionsDirPath,
        statsFilePath: this.statsFilePath,
        runIds,
        updatedEpochs,
      }),
    );
  }

  /**
   * Persists the ISO-8601 emission timestamp for `signalId` on `lessonId` in `statsPath`.
   *
   * Enforces `.emitSignalWhen()` cooldowns across process restarts (`SPEC.md` §3.4.3).
   *
   * @param {string} lessonId  - Lesson identifier.
   * @param {string} signalId  - Signal identifier.
   * @param {string} emittedAt - ISO-8601 emission timestamp.
   *
   * @returns {Promise<void>} Resolves when `statsPath` is atomically updated.
   */
  markSignalEmitted(lessonId: string, signalId: string, emittedAt: string): Promise<void> {
    return this.enqueueLocked(() =>
      markLessonSignalEmittedInStore({
        statsFilePath: this.statsFilePath,
        lessonId,
        signalId,
        emittedAt,
      }),
    );
  }

  /**
   * Permanently retires `lessonIds` in `statsPath` so subsequent `queryCandidates()` calls exclude them.
   *
   * Preserves historical `<definitionsDir>/<lessonId>.json` audit files while marking `retired: true`.
   *
   * @param {readonly string[]} lessonIds - Lesson identifiers to retire.
   *
   * @returns {Promise<void>} Resolves when `statsPath` is atomically updated.
   */
  retire(lessonIds: readonly string[]): Promise<void> {
    return this.enqueueLocked(() =>
      retireLessonsInStore({
        statsFilePath: this.statsFilePath,
        lessonIds,
      }),
    );
  }
}
