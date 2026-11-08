import { createHash } from 'node:crypto';
import type { LessonOutcome, LessonRecord } from '@metaharness/core';
import type Database from 'better-sqlite3';
import type { AdmitLessonParams } from './admit-lesson-params.js';
import { computeNormalizedRelevanceScores } from './compute-normalized-relevance.js';
import type { SqliteLessonRow } from './sqlite-lesson-row.js';

/**
 * Parameters for querying candidate lessons in `queryCandidates`.
 */
export interface QueryLessonCandidatesParams {
  /** Free-text search query $Q$ for BM25 relevance scoring. */
  readonly queryText: string;
  /** Active topology partition identifiers for filtering partition-scoped lessons. */
  readonly partitions: readonly string[];
}

/**
 * Single `(lessonId, outcome)` entry passed to `recordOutcomes`.
 */
export interface LessonOutcomeEntryParams {
  /** Target lesson identifier. */
  readonly lessonId: string;
  /** Recorded 4-state execution outcome. */
  readonly outcome: LessonOutcome;
}

/**
 * Parameters for recording a promotion signal emission timestamp in `markLessonSignalEmittedInSqlite`.
 */
export interface MarkLessonSignalEmittedParams {
  /** Identifier of the lesson that triggered the promotion signal. */
  readonly lessonId: string;
  /** Identifier of the emitted signal. */
  readonly signalId: string;
  /** ISO-8601 timestamp string of the emission. */
  readonly emittedAt: string;
}

/**
 * Maps a persisted `SqliteLessonRow` into an immutable `LessonRecord` with optional `relevanceScore`.
 *
 * Parses `recent_outcomes_json` and `signal_last_emitted_at_json` into frozen structures.
 *
 * @param {SqliteLessonRow}    row            - Persisted lesson row from `harness_lessons`.
 * @param {number | undefined} relevanceScore - Optional normalized relevance score $R(L, Q) \in [0, 1]$.
 *
 * @returns {LessonRecord} Frozen lesson record.
 */
function mapSqliteRowToLessonRecord(
  row: SqliteLessonRow,
  relevanceScore: number | undefined,
): LessonRecord {
  const signalMap =
    row.signal_last_emitted_at_json !== null
      ? Object.freeze(JSON.parse(row.signal_last_emitted_at_json) as Record<string, string>)
      : undefined;
  return Object.freeze<LessonRecord>({
    id: row.id,
    partition: row.partition ?? undefined,
    directive: row.directive,
    epochAtCreation: row.epoch_at_creation,
    createdByRunId: row.created_by_run_id ?? undefined,
    recentOutcomes: Object.freeze(JSON.parse(row.recent_outcomes_json) as LessonOutcome[]),
    totalCleanPasses: row.total_clean_passes,
    totalViolated: row.total_violated,
    relevanceScore,
    signalLastEmittedAt: signalMap,
  });
}

/**
 * Queries non-retired candidate lessons matching `req.partitions` and computes `relevanceScore` $R(L, Q) \in [0, 1]$.
 *
 * Includes global lessons (`partition IS NULL`) and lessons whose `partition` is in `req.partitions`.
 *
 * @param {Database.Database}           db  - Active SQLite database handle.
 * @param {QueryLessonCandidatesParams} req - Search query and active partitions.
 *
 * @returns {readonly LessonRecord[]} Candidate lessons sorted by descending `relevanceScore`.
 */
export function queryLessonCandidatesInSqlite(
  db: Database.Database,
  req: QueryLessonCandidatesParams,
): readonly LessonRecord[] {
  const rows = db
    .prepare('SELECT * FROM harness_lessons WHERE retired = 0 ORDER BY id ASC')
    .all() as SqliteLessonRow[];
  const partitionSet = new Set<string>(req.partitions);
  const eligibleRows: SqliteLessonRow[] = [];
  for (const row of rows) {
    if (row.partition === null || partitionSet.has(row.partition)) {
      eligibleRows.push(row);
    }
  }
  const scoresById = computeNormalizedRelevanceScores(eligibleRows, req.queryText);
  const candidates: LessonRecord[] = [];
  for (const row of eligibleRows) {
    const relevanceScore = scoresById.get(row.id) ?? 0;
    candidates.push(mapSqliteRowToLessonRecord(row, relevanceScore));
  }
  candidates.sort((left, right) => (right.relevanceScore ?? 0) - (left.relevanceScore ?? 0));
  return Object.freeze(candidates);
}

/**
 * Persists a distilled lesson into `harness_lessons` and returns its content-addressed `lessonId`.
 *
 * Deduplicates identical `(partition, directive)` pairs while updating `epochAtCreation` and `createdByRunId`.
 *
 * @param {Database.Database} db     - Active SQLite database handle.
 * @param {AdmitLessonParams} lesson - Lesson candidate to admit.
 *
 * @returns {string} Assigned content-addressed `lessonId`.
 */
export function admitLessonInSqlite(db: Database.Database, lesson: AdmitLessonParams): string {
  const hashHex = createHash('sha256')
    .update(`${lesson.partition ?? ''}:${lesson.directive}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
  const lessonId = `lesson_${hashHex}`;
  const existing = db
    .prepare('SELECT id FROM harness_lessons WHERE id = ?')
    .get(lessonId) as { readonly id: string } | undefined;
  if (existing !== undefined) {
    db.prepare(
      'UPDATE harness_lessons SET epoch_at_creation = ?, created_by_run_id = COALESCE(?, created_by_run_id), retired = 0 WHERE id = ?',
    ).run(lesson.epochAtCreation, lesson.createdByRunId ?? null, lessonId);
    return lessonId;
  }
  db.prepare(
    "INSERT INTO harness_lessons (id, partition, directive, epoch_at_creation, created_by_run_id, recent_outcomes_json, total_clean_passes, total_violated, signal_last_emitted_at_json, retired) VALUES (?, ?, ?, ?, ?, '[]', 0, 0, NULL, 0)",
  ).run(
    lessonId,
    lesson.partition ?? null,
    lesson.directive,
    lesson.epochAtCreation,
    lesson.createdByRunId ?? null,
  );
  return lessonId;
}

/**
 * Appends deduplicated step execution outcomes to the specified lessons in `harness_lessons`.
 *
 * Increments `total_clean_passes` on `'clean_pass'` and `total_violated` on `'violated'`.
 *
 * @param {Database.Database}                    db       - Active SQLite database handle.
 * @param {readonly LessonOutcomeEntryParams[]} outcomes - Recorded outcomes batch.
 *
 * @returns {readonly LessonRecord[]} Updated lesson records for the affected lessons.
 */
export function recordLessonOutcomesInSqlite(
  db: Database.Database,
  outcomes: readonly LessonOutcomeEntryParams[],
): readonly LessonRecord[] {
  const selectStmt = db.prepare('SELECT * FROM harness_lessons WHERE id = ?');
  const updateStmt = db.prepare(
    'UPDATE harness_lessons SET recent_outcomes_json = ?, total_clean_passes = ?, total_violated = ? WHERE id = ?',
  );
  const touchedIds = new Set<string>();
  for (const entry of outcomes) {
    const row = selectStmt.get(entry.lessonId) as SqliteLessonRow | undefined;
    if (row !== undefined) {
      const recent = JSON.parse(row.recent_outcomes_json) as LessonOutcome[];
      recent.push(entry.outcome);
      const cleanPasses = row.total_clean_passes + (entry.outcome === 'clean_pass' ? 1 : 0);
      const violated = row.total_violated + (entry.outcome === 'violated' ? 1 : 0);
      updateStmt.run(JSON.stringify(recent), cleanPasses, violated, entry.lessonId);
      touchedIds.add(entry.lessonId);
    }
  }
  const updatedRecords: LessonRecord[] = [];
  for (const id of touchedIds) {
    const row = selectStmt.get(id) as SqliteLessonRow | undefined;
    if (row !== undefined) {
      updatedRecords.push(mapSqliteRowToLessonRecord(row, undefined));
    }
  }
  return Object.freeze(updatedRecords);
}

/**
 * Aligns `epoch_at_creation` for lessons created by `runIds` when their topology overlays commit to the base store.
 *
 * Updates `epoch_at_creation = newEpoch` for each `(runId, partitionId)` pair in `updatedEpochs`.
 *
 * @param {Database.Database}           db            - Active SQLite database handle.
 * @param {readonly string[]}           runIds        - Committed run identifiers.
 * @param {ReadonlyMap<string, number>} updatedEpochs - Map of `partitionId` to newly committed base epoch.
 *
 * @returns {void} Returns nothing once creation epochs are synchronized.
 */
export function syncLessonEpochsInSqlite(
  db: Database.Database,
  runIds: readonly string[],
  updatedEpochs: ReadonlyMap<string, number>,
): void {
  const stmt = db.prepare(
    'UPDATE harness_lessons SET epoch_at_creation = ? WHERE created_by_run_id = ? AND partition = ?',
  );
  for (const [partitionId, newEpoch] of updatedEpochs.entries()) {
    for (const runId of runIds) {
      stmt.run(newEpoch, runId, partitionId);
    }
  }
}

/**
 * Records the ISO-8601 timestamp when a promotion signal was emitted for `params.lessonId` in SQLite.
 *
 * Updates `signal_last_emitted_at_json[signalId] = emittedAt` on `harness_lessons`.
 *
 * @param {Database.Database}             db     - Active SQLite database handle.
 * @param {MarkLessonSignalEmittedParams} params - Lesson ID, signal ID, and emission timestamp.
 *
 * @returns {void} Returns nothing once the timestamp is persisted.
 */
export function markLessonSignalEmittedInSqlite(
  db: Database.Database,
  params: MarkLessonSignalEmittedParams,
): void {
  const row = db
    .prepare('SELECT signal_last_emitted_at_json FROM harness_lessons WHERE id = ?')
    .get(params.lessonId) as { readonly signal_last_emitted_at_json: string | null } | undefined;
  if (row === undefined) {
    return;
  }
  const map: Record<string, string> =
    row.signal_last_emitted_at_json !== null
      ? (JSON.parse(row.signal_last_emitted_at_json) as Record<string, string>)
      : {};
  map[params.signalId] = params.emittedAt;
  db.prepare('UPDATE harness_lessons SET signal_last_emitted_at_json = ? WHERE id = ?').run(
    JSON.stringify(map),
    params.lessonId,
  );
}

/**
 * Permanently marks the specified `lessonIds` as retired (`retired = 1`) in `harness_lessons`.
 *
 * Excludes retired lessons from all subsequent `queryCandidates()` recalls.
 *
 * @param {Database.Database} db        - Active SQLite database handle.
 * @param {readonly string[]} lessonIds - Identifiers of lessons to retire.
 *
 * @returns {void} Returns nothing once all specified lessons are retired.
 */
export function retireLessonsInSqlite(db: Database.Database, lessonIds: readonly string[]): void {
  const stmt = db.prepare('UPDATE harness_lessons SET retired = 1 WHERE id = ?');
  for (const lessonId of lessonIds) {
    stmt.run(lessonId);
  }
}
