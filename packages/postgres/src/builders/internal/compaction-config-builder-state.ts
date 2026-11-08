import type {
  CompactionSignalTrigger,
  CompactionTerminalExitTrigger,
} from '@metaharness/core';

/**
 * Internal immutable state snapshot for `createCompactionConfigBuilder` in `@metaharness/postgres`.
 *
 * Holds the accumulated signal triggers, terminal exit triggers, and failed-run retention window.
 */
export interface CompactionConfigBuilderState {
  /** Accumulated signal-correlated compaction triggers. */
  readonly signalTriggers: readonly CompactionSignalTrigger[];
  /** Accumulated terminal-exit compaction triggers. */
  readonly terminalExitTriggers: readonly CompactionTerminalExitTrigger[];
  /** Optional retention window in days for failed or exhausted runs. */
  readonly retainFailedRunsForDays: number | undefined;
}
