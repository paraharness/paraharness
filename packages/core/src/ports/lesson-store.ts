import type { LessonOutcome } from './lesson-outcome.types.js';
import type { LessonRecord } from './lesson-record.js';

/**
 * Runtime storage port for querying, admitting, scoring, and retiring empirical lessons.
 *
 * Always resolves file or database paths against the immutable host process root (Invariant 5).
 */
export interface LessonStore {
  /**
   * Queries non-retired candidate lessons relevant to `queryText` and `partitions`.
   *
   * Computes normalized text similarity `relevanceScore` in `[0, 1]` for each candidate lesson.
   *
   * @param {{ readonly queryText: string; readonly partitions: readonly string[] }} req - Search query and active partitions.
   *
   * @returns {Promise<readonly LessonRecord[]>} Candidate lesson records with `relevanceScore` populated.
   */
  queryCandidates(req: {
    readonly queryText: string;
    readonly partitions: readonly string[];
  }): Promise<readonly LessonRecord[]>;

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
  }): Promise<string>;

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
  ): Promise<readonly LessonRecord[]>;

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
  ): Promise<void>;

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
  markSignalEmitted(lessonId: string, signalId: string, emittedAt: string): Promise<void>;

  /**
   * Permanently retires lessons that breached violation or low clean-pass-rate thresholds.
   *
   * Excludes retired lessons from all subsequent `queryCandidates()` recalls.
   *
   * @param {readonly string[]} lessonIds - Identifiers of lessons to retire.
   *
   * @returns {Promise<void>} Resolves when all specified lessons are retired.
   */
  retire(lessonIds: readonly string[]): Promise<void>;
}
