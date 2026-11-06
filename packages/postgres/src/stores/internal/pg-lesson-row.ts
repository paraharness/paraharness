/**
 * Relational row shape for `harness_lessons` in PostgreSQL.
 *
 * Stores empirical lessons, partition scoping, creation epochs, sliding-window outcomes,
 * lifetime counters, promotion signal timestamps, and retirement status.
 */
export interface PgLessonRow {
  /** Primary key lesson identifier. */
  readonly id: string;
  /** Optional partition identifier or `null` for global lessons. */
  readonly partition: string | null;
  /** Preventative rule or architectural directive text. */
  readonly directive: string;
  /** Partition topology epoch at creation or last alignment. */
  readonly epoch_at_creation: number;
  /** Creator run identifier or `null`. */
  readonly created_by_run_id: string | null;
  /** JSON-serialized `LessonOutcome[]` sliding window. */
  readonly recent_outcomes_json: string;
  /** Cumulative count of `'clean_pass'` outcomes. */
  readonly total_clean_passes: number;
  /** Cumulative count of `'violated'` outcomes. */
  readonly total_violated: number;
  /** JSON-serialized `Record<string, string>` of signal emission timestamps or `null`. */
  readonly signal_last_emitted_at_json: string | null;
  /** `1` if the lesson has been permanently retired, else `0`. */
  readonly retired: number;
}
