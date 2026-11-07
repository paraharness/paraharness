import { createHash } from 'node:crypto';
import type { LessonOutcome, LessonRecord } from '@harness-dsl/core';
import type Database from 'better-sqlite3';
import type { AdmitLessonParams } from './admit-lesson-params.js';
import { computeNormalizedRelevanceScores } from './compute-normalized-relevance.js';
import type { SqliteLessonRow } from './sqlite-lesson-row.js';

/**
 * Queries non-retired candidate lessons matching `req.partitions` and computes `relevanceScore` $R(L, Q) \in [0, 1]$.
 *
 * Includes global lessons (`partition IS NULL`) and lessons whose `partition` is in `req.partitions`.
 *
 * @param {Database.Database}                                                      db  - Active SQLite database handle.
 * @param {{ readonly queryText: string; readonly partitions: readonly string[] }} req - Search query and active partitions.
 *
 * @returns {readonly LessonRecord[]} Candidate lessons sorted by descending `relevanceScore`.
 */
export function queryLessonCandidatesInSqlite(
  db: Database.Database,
  req: { readonly queryText: string; readonly partitions: readonly string[] },
): readonly LessonRecord[] {
  const rows = db.prepare('SELECT * FROM harness_lessons WHERE retired = 0 ORDER BY id ASC').all() as SqliteLessonRow[];
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
    const signalMap = row.signal_last_emitted_at_json !== null
      ? Object.freeze(JSON.parse(row.signal_last_emitted_at_json) as Record<string, string>)
      : undefined;
    candidates.push(Object.freeze<LessonRecord>({
      id: row.id, partition: row.partition ?? undefined, directive: row.directive,
      epochAtCreation: row.epoch_at_creation, createdByRunId: row.created_by_run_id ?? undefined,
      recentOutcomes: Object.freeze(JSON.parse(row.recent_outcomes_json) as LessonOutcome[]),
      totalCleanPasses: row.total_clean_passes, totalViolated: row.total_violated,
      relevanceScore, signalLastEmittedAt: signalMap,
    }));
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
  const existing = db.prepare('SELECT id FROM harness_lessons WHERE id = ?').get(lessonId) as { readonly id: string } | undefined;
  if (existing !== undefined) {
    db.prepare('UPDATE harness_lessons SET epoch_at_creation = ?, created_by_run_id = COALESCE(?, created_by_run_id), retired = 0 WHERE id = ?')
      .run(lesson.epochAtCreation, lesson.createdByRunId ?? null, lessonId);
    return lessonId;
  }
  db.prepare(
    "INSERT INTO harness_lessons (id, partition, directive, epoch_at_creation, created_by_run_id, recent_outcomes_json, total_clean_passes, total_violated, signal_last_emitted_at_json, retired) VALUES (?, ?, ?, ?, ?, '[]', 0, 0, NULL, 0)",
  ).run(lessonId, lesson.partition ?? null, lesson.directive, lesson.epochAtCreation, lesson.createdByRunId ?? null);
  return lessonId;
}

/**
 * Appends deduplicated step execution outcomes to the specified lessons in `harness_lessons`.
 *
 * Increments `total_clean_passes` on `'clean_pass'` and `total_violated` on `'violated'`.
 *
 * @param {Database.Database}                                                             db       - Active SQLite database handle.
 * @param {ReadonlyArray<{ readonly lessonId: string; readonly outcome: LessonOutcome }>} outcomes - Recorded outcomes batch.
 *
 * @returns {readonly LessonRecord[]} Updated lesson records for the affected lessons.
 */
export function recordLessonOutcomesInSqlite(
  db: Database.Database,
  outcomes: ReadonlyArray<{ readonly lessonId: string; readonly outcome: LessonOutcome }>,
): readonly LessonRecord[] {
  const selectStmt = db.prepare('SELECT * FROM harness_lessons WHERE id = ?');
  const updateStmt = db.prepare('UPDATE harness_lessons SET recent_outcomes_json = ?, total_clean_passes = ?, total_violated = ? WHERE id = ?');
  const touchedIds = new Set<string>();
  for (const entry of outcomes) {
    const row = selectStmt.get(entry.lessonId) as SqliteLessonRow | undefined;
    if (row === undefined) continue;
    const recent = JSON.parse(row.recent_outcomes_json) as LessonOutcome[];
    recent.push(entry.outcome);
    const cleanPasses = row.total_clean_passes + (entry.outcome === 'clean_pass' ? 1 : 0);
    const violated = row.total_violated + (entry.outcome === 'violated' ? 1 : 0);
    updateStmt.run(JSON.stringify(recent), cleanPasses, violated, entry.lessonId);
    touchedIds.add(entry.lessonId);
  }
  const updatedRecords: LessonRecord[] = [];
  for (const id of touchedIds) {
    const row = selectStmt.get(id) as SqliteLessonRow | undefined;
    if (row === undefined) continue;
    const signalMap = row.signal_last_emitted_at_json !== null ? Object.freeze(JSON.parse(row.signal_last_emitted_at_json) as Record<string, string>) : undefined;
    updatedRecords.push(Object.freeze<LessonRecord>({
      id: row.id, partition: row.partition ?? undefined, directive: row.directive,
      epochAtCreation: row.epoch_at_creation, createdByRunId: row.created_by_run_id ?? undefined,
      recentOutcomes: Object.freeze(JSON.parse(row.recent_outcomes_json) as LessonOutcome[]),
      totalCleanPasses: row.total_clean_passes, totalViolated: row.total_violated,
      relevanceScore: undefined, signalLastEmittedAt: signalMap,
    }));
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
