import type { LessonRecord, LessonStore } from '@paraharness/core';
import type Database from 'better-sqlite3';
import PQueue from 'p-queue';
import { openSqliteConnection } from '../ddl/internal/open-sqlite-connection.js';
import type { AdmitLessonParams } from './internal/admit-lesson-params.js';
import {
  type LessonOutcomeEntryParams,
  type QueryLessonCandidatesParams,
  admitLessonInSqlite,
  markLessonSignalEmittedInSqlite,
  queryLessonCandidatesInSqlite,
  recordLessonOutcomesInSqlite,
  retireLessonsInSqlite,
  syncLessonEpochsInSqlite,
} from './internal/sqlite-lesson-ops.js';

/**
 * WAL-mode SQLite implementation of the `@paraharness/core` `LessonStore` runtime port.
 *
 * Persists distilled empirical lessons, computes normalized candidate relevance $R(L, Q) \in [0, 1]$,
 * tracks 4-state execution outcomes, synchronizes creation epochs, and enforces signal cooldowns.
 */
export class SqliteLessonStore implements LessonStore {
  /** Underlying `better-sqlite3` database connection. */
  private readonly db: Database.Database;
  /** Single-concurrency FIFO queue serializing asynchronous store operations. */
  private readonly queue = new PQueue({ concurrency: 1 });

  /**
   * Initializes a `SqliteLessonStore` against a SQLite file path, `:memory:`, or existing `Database` handle.
   *
   * Applies WAL-mode PRAGMAs and idempotent lesson store DDL statements on initialization.
   *
   * @param {string | Database.Database} uriOrDb - SQLite database URI or open `better-sqlite3` handle.
   */
  constructor(uriOrDb: string | Database.Database) {
    this.db = openSqliteConnection(uriOrDb);
  }

  /**
   * Queries non-retired candidate lessons relevant to `req.queryText` and `req.partitions`.
   *
   * Populates `relevanceScore` in `[0, 1]` on each returned `LessonRecord`.
   *
   * @param {QueryLessonCandidatesParams} req - Search query and active partitions.
   *
   * @returns {Promise<readonly LessonRecord[]>} Candidate lesson records with `relevanceScore` populated.
   */
  queryCandidates(req: QueryLessonCandidatesParams): Promise<readonly LessonRecord[]> {
    return this.queue.add(() => queryLessonCandidatesInSqlite(this.db, req));
  }

  /**
   * Persists a newly distilled lesson into the store and returns its assigned `lessonId`.
   *
   * Deduplicates identical `(partition, directive)` entries and records `epochAtCreation` and `createdByRunId`.
   *
   * @param {AdmitLessonParams} lesson - Lesson definition to admit.
   *
   * @returns {Promise<string>} Newly assigned or content-addressed `lessonId`.
   */
  admit(lesson: AdmitLessonParams): Promise<string> {
    return this.queue.add(() => this.db.transaction(() => admitLessonInSqlite(this.db, lesson))());
  }

  /**
   * Appends deduplicated step execution outcomes to the specified lessons and returns their updated records.
   *
   * Increments `totalCleanPasses` or `totalViolated` and updates each lesson's `recentOutcomes` window.
   *
   * @param {readonly LessonOutcomeEntryParams[]} outcomes - Batch of `(lessonId, outcome)` pairs.
   *
   * @returns {Promise<readonly LessonRecord[]>} Updated lesson records reflecting the recorded outcomes.
   */
  recordOutcomes(outcomes: readonly LessonOutcomeEntryParams[]): Promise<readonly LessonRecord[]> {
    return this.queue.add(() =>
      this.db.transaction(() => recordLessonOutcomesInSqlite(this.db, outcomes))(),
    );
  }

  /**
   * Aligns `epochAtCreation` for lessons created by `runIds` when their topology overlays commit to the base store.
   *
   * Prevents lessons authored in a run that also updated a partition's contract from being falsely penalized for epoch drift.
   *
   * @param {readonly string[]}           runIds        - Run IDs whose topology overlays were committed.
   * @param {ReadonlyMap<string, number>} updatedEpochs - Map of `partitionId` to newly committed base epoch.
   *
   * @returns {Promise<void>} Resolves when creation epochs are synchronized.
   */
  syncCreationEpochsForRuns(
    runIds: readonly string[],
    updatedEpochs: ReadonlyMap<string, number>,
  ): Promise<void> {
    return this.queue.add(() => {
      this.db.transaction(() => syncLessonEpochsInSqlite(this.db, runIds, updatedEpochs))();
    });
  }

  /**
   * Records the ISO-8601 timestamp when a promotion signal was emitted for `lessonId`.
   *
   * Persists the timestamp in `signalLastEmittedAt[signalId]` to enforce `cooldownHours` across restarts.
   *
   * @param {string} lessonId  - Identifier of the lesson that triggered the signal.
   * @param {string} signalId  - Identifier of the emitted signal.
   * @param {string} emittedAt - ISO-8601 timestamp string of the emission.
   *
   * @returns {Promise<void>} Resolves when the cooldown timestamp is persisted.
   */
  markSignalEmitted(lessonId: string, signalId: string, emittedAt: string): Promise<void> {
    return this.queue.add(() => {
      this.db.transaction(() => {
        markLessonSignalEmittedInSqlite(this.db, { lessonId, signalId, emittedAt });
      })();
    });
  }

  /**
   * Permanently retires lessons that breached violation or low clean-pass-rate thresholds.
   *
   * Excludes retired lessons from all subsequent `queryCandidates()` recalls.
   *
   * @param {readonly string[]} lessonIds - Identifiers of lessons to retire.
   *
   * @returns {Promise<void>} Resolves when all specified lessons are retired.
   */
  retire(lessonIds: readonly string[]): Promise<void> {
    return this.queue.add(() => {
      this.db.transaction(() => {
        retireLessonsInSqlite(this.db, lessonIds);
      })();
    });
  }

  /**
   * Closes the underlying `better-sqlite3` database connection.
   *
   * Releases file descriptors and WAL shared-memory locks held by this store instance.
   *
   * @returns {void} Returns nothing once the connection is closed.
   */
  close(): void {
    this.db.close();
  }
}
