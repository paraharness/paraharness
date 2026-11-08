import type { LessonRecord, LessonStore } from '@metaharness/core';
import PQueue from 'p-queue';
import type { Pool } from 'pg';
import { normalizePostgresClient } from '../ddl/internal/normalize-postgres-client.js';
import {
  ensurePostgresSchemaInitialized,
  runInPostgresTransaction,
} from '../ddl/internal/resolve-postgres-client.js';
import type { PostgresQueryClient } from '../ddl/postgres-query-client.js';
import type { AdmitLessonParams } from './internal/admit-lesson-params.js';
import {
  type PgLessonOutcomeEntryParams,
  type QueryPgLessonCandidatesParams,
  admitLessonInPg,
  markLessonSignalEmittedInPg,
  queryLessonCandidatesInPg,
  recordLessonOutcomesInPg,
  retireLessonsInPg,
  syncLessonEpochsInPg,
} from './internal/pg-lesson-ops.js';

/**
 * PostgreSQL implementation of the `@metaharness/core` `LessonStore` runtime port.
 *
 * Persists distilled empirical lessons, computes normalized BM25/fuzzy relevance scores $R(L, Q) \in [0, 1]$,
 * tracks 4-state execution outcome windows, aligns creation epochs on overlay commit, and retires lessons.
 */
export class PostgresLessonStore implements LessonStore {
  /** Underlying PostgreSQL query client. */
  private readonly client: PostgresQueryClient;
  /** Single-concurrency FIFO queue serializing asynchronous store operations. */
  private readonly queue = new PQueue({ concurrency: 1 });
  /** Lazily memoized schema initialization promise. */
  private initPromise: Promise<PostgresQueryClient> | undefined;

  /**
   * Initializes a `PostgresLessonStore` backed by a `PostgresQueryClient`, `pg.Pool`, or connection URI string.
   *
   * Defers DDL execution until the first store operation so constructing the store performs zero I/O.
   *
   * @param {PostgresQueryClient | Pool | string} client - PostgreSQL query client, `pg.Pool`, or connection URI.
   */
  constructor(client: PostgresQueryClient | Pool | string) {
    this.client = normalizePostgresClient(client);
  }

  /**
   * Ensures the PostgreSQL schema DDL has been applied on `this.client`.
   *
   * Memoizes the initialization promise so DDL runs at most once per store instance.
   *
   * @returns {Promise<PostgresQueryClient>} Initialized query client.
   */
  private ensureReady(): Promise<PostgresQueryClient> {
    if (this.initPromise === undefined) {
      this.initPromise = ensurePostgresSchemaInitialized(this.client).catch((error: unknown) => {
        this.initPromise = undefined;
        throw error;
      });
    }
    return this.initPromise;
  }

  /**
   * Queries non-retired candidate lessons relevant to `req.queryText` and `req.partitions`.
   *
   * Computes normalized text similarity `relevanceScore` in `[0, 1]` for each candidate lesson.
   *
   * @param {QueryPgLessonCandidatesParams} req - Search query and active partitions.
   *
   * @returns {Promise<readonly LessonRecord[]>} Candidate lesson records with `relevanceScore` populated.
   */
  queryCandidates(req: QueryPgLessonCandidatesParams): Promise<readonly LessonRecord[]> {
    return this.queue.add(async () => queryLessonCandidatesInPg(await this.ensureReady(), req));
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
    return this.queue.add(async () =>
      runInPostgresTransaction(await this.ensureReady(), (tx) => admitLessonInPg(tx, lesson)),
    );
  }

  /**
   * Appends deduplicated step execution outcomes to the specified lessons and returns their updated records.
   *
   * Increments `totalCleanPasses` or `totalViolated` and updates each lesson's `recentOutcomes` window.
   *
   * @param {readonly PgLessonOutcomeEntryParams[]} outcomes - Batch of `(lessonId, outcome)` pairs.
   *
   * @returns {Promise<readonly LessonRecord[]>} Updated lesson records reflecting the recorded outcomes.
   */
  recordOutcomes(
    outcomes: readonly PgLessonOutcomeEntryParams[],
  ): Promise<readonly LessonRecord[]> {
    return this.queue.add(async () =>
      runInPostgresTransaction(await this.ensureReady(), (tx) =>
        recordLessonOutcomesInPg(tx, outcomes),
      ),
    );
  }

  /**
   * Aligns `epochAtCreation` for lessons created by `runIds` when their topology overlays commit to the base store.
   *
   * Prevents lessons authored in a run that also updated a partition's contract from being falsely penalized.
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
    return this.queue.add(async () =>
      runInPostgresTransaction(await this.ensureReady(), (tx) =>
        syncLessonEpochsInPg(tx, runIds, updatedEpochs),
      ),
    );
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
    return this.queue.add(async () =>
      runInPostgresTransaction(await this.ensureReady(), (tx) =>
        markLessonSignalEmittedInPg(tx, { lessonId, signalId, emittedAt }),
      ),
    );
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
    return this.queue.add(async () =>
      runInPostgresTransaction(await this.ensureReady(), (tx) => retireLessonsInPg(tx, lessonIds)),
    );
  }
}
