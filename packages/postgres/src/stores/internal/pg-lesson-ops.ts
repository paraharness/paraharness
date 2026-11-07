import { createHash } from 'node:crypto';
import type { LessonOutcome, LessonRecord } from '@harness-dsl/core';
import type { PostgresQueryClient } from '../../ddl/postgres-query-client.js';
import type { AdmitLessonParams } from './admit-lesson-params.js';
import { computeNormalizedRelevanceScores } from './compute-normalized-relevance.js';
import type { PgLessonRow } from './pg-lesson-row.js';

/**
 * Queries non-retired candidate lessons matching `req.partitions` and computes `relevanceScore` $R(L, Q) \in [0, 1]$ in PostgreSQL.
 *
 * Includes global lessons (`partition IS NULL`) and lessons whose `partition` is in `req.partitions`.
 *
 * @param {PostgresQueryClient}                                                      client - Active PostgreSQL query client.
 * @param {{ readonly queryText: string; readonly partitions: readonly string[] }}   req    - Search query and active partitions.
 *
 * @returns {Promise<readonly LessonRecord[]>} Candidate lessons sorted by descending `relevanceScore`.
 */
export async function queryLessonCandidatesInPg(
  client: PostgresQueryClient,
  req: { readonly queryText: string; readonly partitions: readonly string[] },
): Promise<readonly LessonRecord[]> {
  const queryResult = await client.query<PgLessonRow>('SELECT * FROM harness_lessons WHERE retired = 0 ORDER BY id ASC');
  const partitionSet = new Set<string>(req.partitions);
  const matchingRows: PgLessonRow[] = [];
  for (const row of queryResult.rows) {
    if (row.partition !== null && !partitionSet.has(row.partition)) continue;
    matchingRows.push(row);
  }
  const relevanceById = computeNormalizedRelevanceScores(matchingRows, req.queryText);
  const candidates: LessonRecord[] = [];
  for (const row of matchingRows) {
    const relevanceScore = relevanceById.get(row.id) ?? 0;
    const signalMap = row.signal_last_emitted_at_json !== null ? Object.freeze(JSON.parse(row.signal_last_emitted_at_json) as Record<string, string>) : undefined;
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
 * Persists a distilled lesson into `harness_lessons` and returns its content-addressed `lessonId` in PostgreSQL.
 *
 * Deduplicates identical `(partition, directive)` pairs while updating `epochAtCreation` and `createdByRunId`.
 *
 * @param {PostgresQueryClient} client - Active PostgreSQL query client.
 * @param {AdmitLessonParams}   lesson - Lesson candidate to admit.
 *
 * @returns {Promise<string>} Assigned content-addressed `lessonId`.
 */
export async function admitLessonInPg(
  client: PostgresQueryClient,
  lesson: AdmitLessonParams,
): Promise<string> {
  const hashHex = createHash('sha256').update(`${lesson.partition ?? ''}:${lesson.directive}`, 'utf8').digest('hex').slice(0, 16);
  const lessonId = `lesson_${hashHex}`;
  const existingQueryResult = await client.query<{ readonly id: string }>('SELECT id FROM harness_lessons WHERE id = $1', [lessonId]);
  if (existingQueryResult.rows[0] !== undefined) {
    await client.query(
      'UPDATE harness_lessons SET epoch_at_creation = $1, created_by_run_id = COALESCE($2, created_by_run_id), retired = 0 WHERE id = $3',
      [lesson.epochAtCreation, lesson.createdByRunId ?? null, lessonId],
    );
    return lessonId;
  }
  await client.query(
    "INSERT INTO harness_lessons (id, partition, directive, epoch_at_creation, created_by_run_id, recent_outcomes_json, total_clean_passes, total_violated, signal_last_emitted_at_json, retired) VALUES ($1, $2, $3, $4, $5, '[]', 0, 0, NULL, 0)",
    [lessonId, lesson.partition ?? null, lesson.directive, lesson.epochAtCreation, lesson.createdByRunId ?? null],
  );
  return lessonId;
}

/**
 * Appends deduplicated step execution outcomes to the specified lessons in `harness_lessons` in PostgreSQL.
 *
 * Increments `total_clean_passes` on `'clean_pass'` and `total_violated` on `'violated'`.
 *
 * @param {PostgresQueryClient}                                                             client   - Active PostgreSQL query client.
 * @param {ReadonlyArray<{ readonly lessonId: string; readonly outcome: LessonOutcome }>}   outcomes - Recorded outcomes batch.
 *
 * @returns {Promise<readonly LessonRecord[]>} Updated lesson records for the affected lessons.
 */
export async function recordLessonOutcomesInPg(
  client: PostgresQueryClient,
  outcomes: ReadonlyArray<{ readonly lessonId: string; readonly outcome: LessonOutcome }>,
): Promise<readonly LessonRecord[]> {
  const touchedIds = new Set<string>();
  for (const entry of outcomes) {
    const queryResult = await client.query<PgLessonRow>('SELECT * FROM harness_lessons WHERE id = $1', [entry.lessonId]);
    const row = queryResult.rows[0];
    if (row === undefined) continue;
    const recent = JSON.parse(row.recent_outcomes_json) as LessonOutcome[];
    recent.push(entry.outcome);
    const cleanPasses = row.total_clean_passes + (entry.outcome === 'clean_pass' ? 1 : 0);
    const violated = row.total_violated + (entry.outcome === 'violated' ? 1 : 0);
    await client.query('UPDATE harness_lessons SET recent_outcomes_json = $1, total_clean_passes = $2, total_violated = $3 WHERE id = $4', [JSON.stringify(recent), cleanPasses, violated, entry.lessonId]);
    touchedIds.add(entry.lessonId);
  }
  const updatedRecords: LessonRecord[] = [];
  for (const id of touchedIds) {
    const queryResult = await client.query<PgLessonRow>('SELECT * FROM harness_lessons WHERE id = $1', [id]);
    const row = queryResult.rows[0];
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
 * Aligns `epoch_at_creation` for lessons created by `runIds` when their topology overlays commit to the base store in PostgreSQL.
 *
 * Updates `epoch_at_creation = newEpoch` for each `(runId, partitionId)` pair in `updatedEpochs`.
 *
 * @param {PostgresQueryClient}         client        - Active PostgreSQL query client.
 * @param {readonly string[]}           runIds        - Committed run identifiers.
 * @param {ReadonlyMap<string, number>} updatedEpochs - Map of `partitionId` to newly committed base epoch.
 *
 * @returns {Promise<void>} Resolves once creation epochs are synchronized.
 */
export async function syncLessonEpochsInPg(
  client: PostgresQueryClient,
  runIds: readonly string[],
  updatedEpochs: ReadonlyMap<string, number>,
): Promise<void> {
  for (const [partitionId, newEpoch] of updatedEpochs.entries()) {
    for (const runId of runIds) {
      await client.query(
        'UPDATE harness_lessons SET epoch_at_creation = $1 WHERE created_by_run_id = $2 AND partition = $3',
        [newEpoch, runId, partitionId],
      );
    }
  }
}
