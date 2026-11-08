import type { CompactionSignalTrigger, CompactionTerminalExitTrigger } from '@paraharness/core';

/**
 * Immutable internal state snapshot for `createCompactionConfigBuilder`.
 *
 * Accumulates signal triggers, terminal-state triggers, and failed-run retention windows
 * across copy-on-write builder transitions.
 */
export interface CompactionConfigBuilderState {
  /** Signal-driven compaction triggers accumulated on the builder. */
  readonly signalTriggers?: readonly CompactionSignalTrigger[];
  /** Terminal exit state triggers accumulated on the builder. */
  readonly terminalExitTriggers?: readonly CompactionTerminalExitTrigger[];
  /** Optional retention window in days for failed runs. */
  readonly retainFailedRunsForDays?: number;
}
