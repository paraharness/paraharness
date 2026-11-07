import { createHash } from 'node:crypto';
import type { LessonRecord } from '@harness-dsl/core';
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
 * Computes normalized text similarity $R(L, Q) \in [0, 1]$ between `queryText` and a lesson definition.
 *
 * Calculates token overlap across lowercased alphanumeric tokens in `queryText` and the lesson's
 * `partition` and `directive` text (`SPEC.md` §2.7 & §3.4.3).
 *
 * @param {string}                                   queryText  - Search query extracted from actor input.
 * @param {FsLessonDefinitionRecord}                 definition - Immutable lesson definition record.
 * @param {ReadonlySet<string> | readonly string[]}  partitions - Active task partitions.
 *
 * @returns {number} Normalized relevance score in `[0, 1]`.
 */
export function computeQueryRelevanceScore(
  queryText: string,
  definition: FsLessonDefinitionRecord,
  partitions: ReadonlySet<string> | readonly string[],
): number {
  const queryMatches = queryText.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  if (queryMatches.length === 0) {
    return 1;
  }
  const queryTokenSet = new Set(queryMatches);
  const docText = `${definition.partition ?? ''} ${definition.directive}`.toLowerCase();
  const docTokenSet = new Set(docText.match(/[a-z0-9]+/g) ?? []);
  let matchedCount = 0;
  for (const token of queryTokenSet) {
    if (docTokenSet.has(token)) {
      matchedCount += 1;
    }
  }
  if (matchedCount > 0) {
    return matchedCount / queryTokenSet.size;
  }
  const partitionSet = partitions instanceof Set ? partitions : new Set(partitions);
  if (definition.partition !== undefined && partitionSet.has(definition.partition)) {
    return 0.25;
  }
  return 0.05;
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
