/**
 * Raw SQLite row shape for `harness_lessons`.
 *
 * Maps persisted empirical lesson fields, outcome counters, and retirement state.
 */
export interface SqliteLessonRow {
  /** Content-addressed lesson identifier. */
  readonly id: string;
  /** Optional logical partition identifier, or `null`. */
  readonly partition: string | null;
  /** Preventative rule or architectural directive text. */
  readonly directive: string;
  /** Partition topology epoch at creation or last sync. */
  readonly epoch_at_creation: number;
  /** Optional creator run ID (`lastMutatedByRunId ?? runId`), or `null`. */
  readonly created_by_run_id: string | null;
  /** JSON-serialized `LessonOutcome[]` array. */
  readonly recent_outcomes_json: string;
  /** Lifetime count of `'clean_pass'` outcomes. */
  readonly total_clean_passes: number;
  /** Lifetime count of `'violated'` outcomes. */
  readonly total_violated: number;
  /** Optional JSON-serialized `Record<string, string>` of signal emission timestamps. */
  readonly signal_last_emitted_at_json: string | null;
  /** Retirement flag (`1` when retired, `0` when active). */
  readonly retired: number;
}
