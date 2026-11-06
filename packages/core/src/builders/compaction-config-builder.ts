import type { AstBuilder } from '../ast/ast-builder.js';
import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type { CompactionConfigNode } from '../ast/compaction-config-node.js';
import type { SignalNode } from '../ast/signal-node.js';

/**
 * Fluent configurator for ledger wire-frame compaction policies (`.compactWhen($c => ...)`).
 *
 * Schedules raw wire-frame pruning for terminal runs based on correlated signals,
 * terminal flow exit states, and failed-run retention windows.
 */
export interface CompactionConfigBuilder extends AstBuilder<CompactionConfigNode> {
  /**
   * Registers a signal-driven compaction trigger correlated to a completed run's `itemKey`.
   *
   * Schedules raw wire-frame pruning once `signal` arrives and `options.afterGracePeriodHours` elapses.
   *
   * @template TSig Signal payload type.
   *
   * @param {MaybeBuilder<SignalNode<TSig>>}                                                          signal  - Target signal AST node or builder.
   * @param {{ readonly correlateBy: (sig: TSig) => string; readonly afterGracePeriodHours: number }} options - Correlation mapper and grace period in hours.
   *
   * @returns {CompactionConfigBuilder} New immutable compaction config builder.
   */
  onSignal<TSig>(
    signal: MaybeBuilder<SignalNode<TSig>>,
    options: {
      readonly correlateBy: (sig: TSig) => string;
      readonly afterGracePeriodHours: number;
    },
  ): CompactionConfigBuilder;

  /**
   * Registers a terminal exit state compaction trigger for completed runs.
   *
   * Schedules raw wire-frame pruning once a run reaches one of `states` and `options.afterGracePeriodHours` elapses.
   *
   * @param {readonly string[]}                          states  - Terminal flow exit states that arm compaction.
   * @param {{ readonly afterGracePeriodHours: number }} options - Grace period in hours after terminal exit.
   *
   * @returns {CompactionConfigBuilder} New immutable compaction config builder.
   */
  onTerminalExit(
    states: readonly string[],
    options: { readonly afterGracePeriodHours: number },
  ): CompactionConfigBuilder;

  /**
   * Sets the retention window in days for failed or exhausted runs before raw wire frames are pruned.
   *
   * Preserves failed run wire frames for post-mortem debugging across `days` days.
   *
   * @param {number} days - Positive retention window in days.
   *
   * @returns {CompactionConfigBuilder} New immutable compaction config builder.
   */
  retainFailedRunsForDays(days: number): CompactionConfigBuilder;
}
