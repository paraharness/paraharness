import type { LessonOutcome } from './lesson-outcome.types.js';

/**
 * Stored empirical lesson record with sliding-window outcome history and relevance scoring metadata.
 *
 * Tracks the lesson's partition tag, creation epoch, recent 4-state execution outcomes,
 * lifetime pass/violation counters, and promotion signal emission timestamps.
 */
export interface LessonRecord {
  /** Unique content-addressed or store-assigned identifier of the lesson. */
  readonly id: string;
  /** Optional logical partition identifier associated with the lesson. */
  readonly partition?: string;
  /** Preventative rule or architectural directive injected into actor context. */
  readonly directive: string;
  /** Partition topology epoch at which the lesson was created or last aligned. */
  readonly epochAtCreation: number;
  /** Optional `runId` (or `lastMutatedByRunId`) attributed as the creator of this lesson. */
  readonly createdByRunId?: string;
  /** Sliding-window sequence of deduplicated 4-state execution outcomes. */
  readonly recentOutcomes: readonly LessonOutcome[];
  /** Cumulative lifetime count of `'clean_pass'` outcomes. */
  readonly totalCleanPasses: number;
  /** Cumulative lifetime count of `'violated'` outcomes. */
  readonly totalViolated: number;
  /** Optional normalized text similarity score `R(L, Q)` in `[0, 1]` populated by `queryCandidates()`. */
  readonly relevanceScore?: number;
  /** Optional map of `signalId` to ISO-8601 emission timestamp enforcing `.emitSignalWhen()` cooldowns. */
  readonly signalLastEmittedAt?: Readonly<Record<string, string>>;
}
