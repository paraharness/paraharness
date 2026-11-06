import type {
  CompactionSignalTrigger,
  CompactionTerminalExitTrigger,
} from '../../ast/compaction-config-node.js';

/**
 * Immutable copy-on-write state snapshot backing `CompactionConfigBuilder`.
 *
 * Accumulates signal-correlated compaction triggers, terminal-state compaction triggers,
 * and failed-run retention windows before compiling to `CompactionConfigNode`.
 */
export interface CompactionConfigBuilderState {
  /** Signal-driven compaction triggers correlated to completed runs. */
  readonly signalTriggers?: readonly CompactionSignalTrigger[];
  /** Terminal-state-driven compaction triggers. */
  readonly terminalExitTriggers?: readonly CompactionTerminalExitTrigger[];
  /** Optional retention window in days for failed or exhausted runs. */
  readonly retainFailedRunsForDays?: number;
}
