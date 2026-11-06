import type { LessonOutcome, LessonRecord, LessonStore } from '@harness-dsl/core';
import type Database from 'better-sqlite3';
import { openSqliteConnection } from '../ddl/internal/open-sqlite-connection.js';
import {
  admitLessonInSqlite,
  queryLessonCandidatesInSqlite,
  recordLessonOutcomesInSqlite,
  syncLessonEpochsInSqlite,
} from './internal/sqlite-lesson-ops.js';

/**
 * WAL-mode SQLite implementation of the `@harness-dsl/core` `LessonStore` runtime port.
 *
 * Persists distilled empirical lessons, computes normalized candidate relevance $R(L, Q) \in [0, 1]$,
 * tracks 4-state execution outcomes, synchronizes creation epochs, and enforces signal cooldowns.
 */
export class SqliteLessonStore implements LessonStore {
  /** Underlying `better-sqlite3` database connection. */
  private readonly db: Database.Database;

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
   * @param {{ readonly queryText: string; readonly partitions: readonly string[] }} req - Search query and active partitions.
   *
   * @returns {Promise<readonly LessonRecord[]>} Candidate lesson records with `relevanceScore` populated.
   */
  queryCandidates(req: {
    readonly queryText: string;
    readonly partitions: readonly string[];
  }): Promise<readonly LessonRecord[]> {
    return Promise.resolve(queryLessonCandidatesInSqlite(this.db, req));
  }

  /**
   * Persists a newly distilled lesson into the store and returns its assigned `lessonId`.
   *
   * Deduplicates identical `(partition, directive)` entries and records `epochAtCreation` and `createdByRunId`.
   *
   * @param {{ readonly partition?: string; readonly directive: string; readonly epochAtCreation: number; readonly createdByRunId?: string }} lesson - Lesson definition to admit.
   *
   * @returns {Promise<string>} Newly assigned or content-addressed `lessonId`.
   */
  admit(lesson: {
    readonly partition?: string;
    readonly directive: string;
    readonly epochAtCreation: number;
    readonly createdByRunId?: string;
  }): Promise<string> {
    const tx = this.db.transaction(() => admitLessonInSqlite(this.db, lesson));
    return Promise.resolve(tx());
  }

  /**
   * Appends deduplicated step execution outcomes to the specified lessons and returns their updated records.
   *
   * Increments `totalCleanPasses` or `totalViolated` and updates each lesson's `recentOutcomes` window.
   *
   * @param {ReadonlyArray<{ readonly lessonId: string; readonly outcome: LessonOutcome }>} outcomes - Batch of `(lessonId, outcome)` pairs.
   *
   * @returns {Promise<readonly LessonRecord[]>} Updated lesson records reflecting the recorded outcomes.
   */
  recordOutcomes(
    outcomes: ReadonlyArray<{ readonly lessonId: string; readonly outcome: LessonOutcome }>,
  ): Promise<readonly LessonRecord[]> {
    const tx = this.db.transaction(() => recordLessonOutcomesInSqlite(this.db, outcomes));
    return Promise.resolve(tx());
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
    const tx = this.db.transaction(() => syncLessonEpochsInSqlite(this.db, runIds, updatedEpochs));
    tx();
    return Promise.resolve();
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
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT signal_last_emitted_at_json FROM harness_lessons WHERE id = ?')
        .get(lessonId) as { readonly signal_last_emitted_at_json: string | null } | undefined;
      if (row === undefined) {
        return;
      }
      const map: Record<string, string> =
        row.signal_last_emitted_at_json !== null
          ? (JSON.parse(row.signal_last_emitted_at_json) as Record<string, string>)
          : {};
      map[signalId] = emittedAt;
      this.db
        .prepare('UPDATE harness_lessons SET signal_last_emitted_at_json = ? WHERE id = ?')
        .run(JSON.stringify(map), lessonId);
    });
    tx();
    return Promise.resolve();
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
    const tx = this.db.transaction(() => {
      const stmt = this.db.prepare('UPDATE harness_lessons SET retired = 1 WHERE id = ?');
      for (const lessonId of lessonIds) {
        stmt.run(lessonId);
      }
    });
    tx();
    return Promise.resolve();
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
