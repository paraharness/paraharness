import type { LessonOutcome } from '../../src/ports/lesson-outcome.types.js';
import type { LessonRecord } from '../../src/ports/lesson-record.js';
import type { LessonStore } from '../../src/ports/lesson-store.js';

/**
 * Deterministic in-memory `LessonStore` test fixture (`SPEC.md` §3.4.3).
 *
 * Implements candidate recall querying, deduplicated admission, outcome recording, creation-epoch
 * synchronization across committed runs, promotion signal cooldown timestamps, and retirement.
 */
export class InMemoryLessonStore implements LessonStore {
  /** Stored lessons keyed by `lessonId`. */
  readonly lessons = new Map<string, LessonRecord>();
  /** Retired lesson IDs excluded from `queryCandidates()`. */
  readonly retiredIds = new Set<string>();
  /** Recorded `recordOutcomes()` batches for test assertions. */
  readonly recordedBatches: Array<ReadonlyArray<{ readonly lessonId: string; readonly outcome: LessonOutcome }>> = [];
  /** Recorded `queryCandidates()` requests for test assertions. */
  readonly recordedQueries: Array<{ readonly queryText: string; readonly partitions: readonly string[] }> = [];

  /**
   * Initializes the in-memory lesson store with optional seed lessons.
   *
   * Populates `lessons` with frozen `LessonRecord` entries.
   *
   * @param {readonly LessonRecord[]} [seed] - Optional initial lesson records.
   */
  constructor(seed?: readonly LessonRecord[]) {
    for (const l of seed ?? []) {
      this.lessons.set(l.id, l);
    }
  }

  /**
   * Queries non-retired candidate lessons relevant to `req.queryText` and `req.partitions`.
   *
   * Returns all non-retired lessons with their configured `relevanceScore` (defaulting to `1`).
   *
   * @param {{ readonly queryText: string; readonly partitions: readonly string[] }} req - Search query and active partitions.
   *
   * @returns {Promise<readonly LessonRecord[]>} Non-retired candidate lessons.
   */
  async queryCandidates(req: { readonly queryText: string; readonly partitions: readonly string[] }): Promise<readonly LessonRecord[]> {
    this.recordedQueries.push(Object.freeze({ queryText: req.queryText, partitions: Object.freeze([...req.partitions]) }));
    const out: LessonRecord[] = [];
    for (const l of this.lessons.values()) {
      if (!this.retiredIds.has(l.id)) out.push(l);
    }
    return Object.freeze(out);
  }

  /**
   * Admits a newly distilled lesson into the store (deduplicating identical `(partition, directive)` pairs).
   *
   * Assigns a deterministic `lesson-${index}` identifier when creating a new record.
   *
   * @param {{ readonly partition?: string; readonly directive: string; readonly epochAtCreation: number; readonly createdByRunId?: string }} lesson - Lesson definition to admit.
   *
   * @returns {Promise<string>} Assigned or deduplicated `lessonId`.
   */
  async admit(lesson: { readonly partition?: string; readonly directive: string; readonly epochAtCreation: number; readonly createdByRunId?: string }): Promise<string> {
    for (const existing of this.lessons.values()) {
      if (existing.partition === lesson.partition && existing.directive === lesson.directive && !this.retiredIds.has(existing.id)) {
        return existing.id;
      }
    }
    const id = `lesson-${String(this.lessons.size + 1)}`;
    const record = Object.freeze<LessonRecord>({
      id,
      partition: lesson.partition,
      directive: lesson.directive,
      epochAtCreation: lesson.epochAtCreation,
      createdByRunId: lesson.createdByRunId,
      recentOutcomes: Object.freeze([]),
      totalCleanPasses: 0,
      totalViolated: 0,
      signalLastEmittedAt: Object.freeze({}),
      relevanceScore: 1,
    });
    this.lessons.set(id, record);
    return id;
  }

  /**
   * Appends deduplicated step execution outcomes to the specified lessons and returns their updated records.
   *
   * Increments `totalCleanPasses` on `'clean_pass'` and `totalViolated` on `'violated'`.
   *
   * @param {ReadonlyArray<{ readonly lessonId: string; readonly outcome: LessonOutcome }>} outcomes - Batch of `(lessonId, outcome)` pairs.
   *
   * @returns {Promise<readonly LessonRecord[]>} Updated lesson records.
   */
  async recordOutcomes(outcomes: ReadonlyArray<{ readonly lessonId: string; readonly outcome: LessonOutcome }>): Promise<readonly LessonRecord[]> {
    this.recordedBatches.push(outcomes);
    const updated: LessonRecord[] = [];
    for (const { lessonId, outcome } of outcomes) {
      const existing = this.lessons.get(lessonId);
      if (existing === undefined) continue;
      const nextRecord = Object.freeze<LessonRecord>({
        ...existing,
        recentOutcomes: Object.freeze([...existing.recentOutcomes, outcome]),
        totalCleanPasses: existing.totalCleanPasses + (outcome === 'clean_pass' ? 1 : 0),
        totalViolated: existing.totalViolated + (outcome === 'violated' ? 1 : 0),
      });
      this.lessons.set(lessonId, nextRecord);
      updated.push(nextRecord);
    }
    return Object.freeze(updated);
  }

  /**
   * Aligns `epochAtCreation` for lessons created by `runIds` when their topology overlays commit to the base store.
   *
   * Updates `epochAtCreation` to `updatedEpochs.get(lesson.partition)` for matching lessons.
   *
   * @param {readonly string[]}           runIds        - Run IDs whose topology overlays committed.
   * @param {ReadonlyMap<string, number>} updatedEpochs - Map of `partitionId` to newly committed base epoch.
   *
   * @returns {Promise<void>} Resolves once synchronized.
   */
  async syncCreationEpochsForRuns(runIds: readonly string[], updatedEpochs: ReadonlyMap<string, number>): Promise<void> {
    for (const [id, lesson] of this.lessons.entries()) {
      if (lesson.createdByRunId !== undefined && runIds.includes(lesson.createdByRunId) && lesson.partition !== undefined) {
        const newEpoch = updatedEpochs.get(lesson.partition);
        if (newEpoch !== undefined) {
          this.lessons.set(id, Object.freeze<LessonRecord>({ ...lesson, epochAtCreation: newEpoch }));
        }
      }
    }
  }

  /**
   * Records the ISO-8601 timestamp when a promotion signal was emitted for `lessonId`.
   *
   * Updates `signalLastEmittedAt[signalId]` on the stored `LessonRecord`.
   *
   * @param {string} lessonId  - Identifier of the lesson that triggered the signal.
   * @param {string} signalId  - Identifier of the emitted signal.
   * @param {string} emittedAt - ISO-8601 timestamp string.
   *
   * @returns {Promise<void>} Resolves once recorded.
   */
  async markSignalEmitted(lessonId: string, signalId: string, emittedAt: string): Promise<void> {
    const existing = this.lessons.get(lessonId);
    if (existing !== undefined) {
      this.lessons.set(lessonId, Object.freeze<LessonRecord>({
        ...existing,
        signalLastEmittedAt: Object.freeze({ ...existing.signalLastEmittedAt, [signalId]: emittedAt }),
      }));
    }
  }

  /**
   * Permanently retires the specified lessons.
   *
   * Marks `retired: true` and adds each ID to `retiredIds`.
   *
   * @param {readonly string[]} lessonIds - Identifiers of lessons to retire.
   *
   * @returns {Promise<void>} Resolves once retired.
   */
  async retire(lessonIds: readonly string[]): Promise<void> {
    for (const id of lessonIds) {
      this.retiredIds.add(id);
    }
  }
}
