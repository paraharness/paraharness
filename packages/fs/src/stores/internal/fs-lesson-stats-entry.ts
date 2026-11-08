import type { LessonOutcome } from '@metaharness/core';

/**
 * Mutable per-lesson telemetry counter record persisted in `statsPath` (`SPEC.md` §4.3).
 *
 * Tracks sliding-window outcomes, cumulative pass/violation counters, post-commit
 * `epochAtCreation` overrides, signal emission timestamps, and retirement status.
 */
export interface FsLessonStatsEntry {
  /** Ordered list of recorded 4-state step outcomes for this lesson. */
  readonly recentOutcomes: readonly LessonOutcome[];
  /** Cumulative number of `'clean_pass'` outcomes recorded. */
  readonly totalCleanPasses: number;
  /** Cumulative number of `'violated'` outcomes recorded. */
  readonly totalViolated: number;
  /** Optional synchronized creation epoch override written by `syncCreationEpochsForRuns`. */
  readonly epochAtCreation?: number;
  /** Optional map of `signalId` to ISO-8601 emission timestamp from `markSignalEmitted`. */
  readonly signalLastEmittedAt?: Readonly<Record<string, string>>;
  /** True when the lesson has been permanently retired via `retire()`. */
  readonly retired?: boolean;
}
