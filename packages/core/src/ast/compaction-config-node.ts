import type { BivariantCallback } from './ast-foundation.types.js';
import type { SignalNode } from './signal-node.js';

/**
 * Signal-correlated ledger frame compaction trigger configuration.
 *
 * Schedules raw wire-frame pruning for a completed run once `signal` arrives, correlates
 * to the run's `itemKey`, and the post-signal `afterGracePeriodHours` window elapses.
 *
 * @template TSig Signal payload type.
 */
export interface CompactionSignalTrigger<TSig = unknown> {
  /** Signal that schedules wire frame compaction for the correlated run. */
  readonly signal: SignalNode<TSig>;
  /** Pure projection extracting the lane `itemKey` from the signal payload. */
  readonly correlateBy: BivariantCallback<[sig: TSig], string>;
  /** Grace period in hours after signal receipt before raw wire frames are pruned. */
  readonly afterGracePeriodHours: number;
}

/**
 * Terminal run exit state compaction trigger configuration.
 *
 * Schedules raw wire frame pruning once a run reaches one of `states` and the grace period elapses.
 */
export interface CompactionTerminalExitTrigger {
  /** Terminal flow exit states that arm the compaction timer. */
  readonly states: readonly string[];
  /** Grace period in hours after terminal exit before raw wire frames are pruned. */
  readonly afterGracePeriodHours: number;
}

/**
 * Passive AST node defining ledger wire-frame compaction policies.
 *
 * Attached to `LedgerStoreASTNode` definitions via `.compactWhen()` to prune raw
 * `WireFrameRecord` payloads while retaining run receipts and telemetry.
 */
export interface CompactionConfigNode {
  /** Discriminant identifying a ledger compaction configuration node. */
  readonly type: 'harness:compaction';
  /** Signal-driven compaction triggers correlated to completed runs. */
  readonly signalTriggers: readonly CompactionSignalTrigger[];
  /** Terminal-state-driven compaction triggers. */
  readonly terminalExitTriggers: readonly CompactionTerminalExitTrigger[];
  /** Optional retention window in days for failed or exhausted runs. */
  readonly retainFailedRunsForDays?: number;
}
