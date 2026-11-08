import { createHash } from 'node:crypto';
import type { LessonRecord } from '@metaharness/core';
import MiniSearch from 'minisearch';
import type { FsLessonDefinitionRecord } from './fs-lesson-definition-record.js';
import type { FsLessonStatsEntry } from './fs-lesson-stats-entry.js';

/**
 * Computes a deterministic content-addressed `lessonId` from `partition` and `directive`.
 *
 * Deduplicates identical `(partition, directive)` admissions across runs (`SPEC.md` §4.3).
 *
 * @param {string | undefined} partition - Optional partition identifier.
 * @param {string}             directive - Lesson directive text.
 *
 * @returns {string} Content-addressed lesson identifier (`lesson-<16-hex>`).
 */
export function computeLessonId(partition: string | undefined, directive: string): string {
  const hash = createHash('sha256')
    .update(`${partition ?? ''}::${directive.trim()}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
  return `lesson-${hash}`;
}

/**
 * Computes normalized BM25 text similarity $R(L, Q) \in [0, 1]$ across `definitions` using `MiniSearch`.
 *
 * Indexes `directive` and `partition` fields with `{ prefix: true, fuzzy: 0.2 }` and normalizes
 * BM25 scores against the top-scoring candidate (`SPEC.md` §2.7 & §3.4.3).
 *
 * @param {string}                                   queryText   - Search query extracted from actor input.
 * @param {readonly FsLessonDefinitionRecord[]}      definitions - Active non-retired lesson definitions.
 * @param {ReadonlySet<string> | readonly string[]}  partitions  - Active task partitions.
 *
 * @returns {ReadonlyMap<string, number>} Map of `lessonId` to normalized relevance score in `[0, 1]`.
 */
export function scoreLessonsWithMiniSearch(
  queryText: string,
  definitions: readonly FsLessonDefinitionRecord[],
  partitions: ReadonlySet<string> | readonly string[],
): ReadonlyMap<string, number> {
  const scoresById = new Map<string, number>();
  if (definitions.length === 0) return scoresById;
  const trimmedQuery = queryText.trim();
  if (trimmedQuery.length === 0) {
    for (const def of definitions) scoresById.set(def.id, 1);
    return scoresById;
  }
  const miniSearch = new MiniSearch<{
    readonly id: string;
    readonly directive: string;
    readonly partition: string;
  }>({
    fields: ['directive', 'partition'],
    storeFields: ['id'],
    searchOptions: { prefix: true, fuzzy: 0.2 },
  });
  for (const def of definitions) {
    miniSearch.add({ id: def.id, directive: def.directive, partition: def.partition ?? '' });
  }
  const hits = miniSearch.search(trimmedQuery, { prefix: true, fuzzy: 0.2 });
  const maxScore = hits[0]?.score ?? 0;
  const rawScoreById = new Map<string, number>();
  for (const hit of hits) rawScoreById.set(String(hit.id), hit.score);
  const partitionSet = partitions instanceof Set ? partitions : new Set(partitions);
  for (const def of definitions) {
    const rawScore = rawScoreById.get(def.id);
    if (rawScore !== undefined && maxScore > 0) {
      scoresById.set(def.id, Math.min(1, Math.max(0.1, rawScore / maxScore)));
    } else if (def.partition !== undefined && partitionSet.has(def.partition)) {
      scoresById.set(def.id, 0.05);
    } else {
      scoresById.set(def.id, 0);
    }
  }
  return scoresById;
}

/**
 * Merges an immutable `FsLessonDefinitionRecord` with its mutable `FsLessonStatsEntry` into a `LessonRecord`.
 *
 * Applies any `epochAtCreation` override from `stats` while preserving monomorphic `LessonRecord` property order (`Rule 4.3`).
 *
 * @param {FsLessonDefinitionRecord}       definition       - Immutable lesson definition record.
 * @param {FsLessonStatsEntry | undefined} stats            - Mutable telemetry counters for the lesson.
 * @param {number | undefined}             [relevanceScore] - Optional query relevance score in `[0, 1]`.
 *
 * @returns {LessonRecord} Frozen `LessonRecord`.
 */
export function mergeDefinitionAndStats(
  definition: FsLessonDefinitionRecord,
  stats: FsLessonStatsEntry | undefined,
  relevanceScore?: number,
): LessonRecord {
  return Object.freeze<LessonRecord>({
    id: definition.id,
    partition: definition.partition,
    directive: definition.directive,
    epochAtCreation: stats?.epochAtCreation ?? definition.epochAtCreation,
    createdByRunId: definition.createdByRunId,
    recentOutcomes: Object.freeze([...(stats?.recentOutcomes ?? [])]),
    totalCleanPasses: stats?.totalCleanPasses ?? 0,
    totalViolated: stats?.totalViolated ?? 0,
    relevanceScore,
    signalLastEmittedAt:
      stats?.signalLastEmittedAt !== undefined
        ? Object.freeze({ ...stats.signalLastEmittedAt })
        : undefined,
  });
}

/**
 * Compares two `LessonRecord` entries by descending `relevanceScore` with lexicographical `id` tie-breaking.
 *
 * @param {LessonRecord} left  - First lesson record.
 * @param {LessonRecord} right - Second lesson record.
 *
 * @returns {number} Negative when `left` ranks ahead of `right`, positive when behind, or `0`.
 */
export function compareLessonRecordsByRelevance(
  left: LessonRecord,
  right: LessonRecord,
): number {
  const leftScore = left.relevanceScore ?? 0;
  const rightScore = right.relevanceScore ?? 0;
  if (rightScore !== leftScore) {
    return rightScore - leftScore;
  }
  return left.id.localeCompare(right.id);
}
