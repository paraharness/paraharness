import type { AstBuilder, CompactionConfigNode, MaybeBuilder, SignalNode } from '@paraharness/core';

/**
 * Options for configuring a signal-correlated ledger compaction trigger via `CompactionConfigBuilder.onSignal`.
 *
 * Maps an incoming signal payload to its target `itemKey` and specifies the grace period before raw wire frames are pruned.
 *
 * @template TSig Signal payload type.
 */
export interface CompactionSignalTriggerOptions<TSig = unknown> {
  /** Pure function extracting the correlated `itemKey` from the signal payload. */
  readonly correlateBy: (sig: TSig) => string;
  /** Non-negative retention grace period in hours after signal arrival before pruning raw wire frames. */
  readonly afterGracePeriodHours: number;
}

/**
 * Options for configuring a terminal exit state compaction trigger via `CompactionConfigBuilder.onTerminalExit`.
 *
 * Specifies the retention grace period in hours after a run reaches a configured terminal flow state.
 */
export interface CompactionTerminalExitOptions {
  /** Non-negative retention grace period in hours after terminal exit before pruning raw wire frames. */
  readonly afterGracePeriodHours: number;
}

/**
 * Fluent configurator for PostgreSQL ledger wire-frame compaction policies (`.compactWhen($c => ...)`).
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
   * @param {MaybeBuilder<SignalNode<TSig>>}      signal  - Target signal AST node or builder.
   * @param {CompactionSignalTriggerOptions<TSig>} options - Correlation mapper and grace period in hours.
   *
   * @returns {CompactionConfigBuilder} Updated immutable compaction configuration builder.
   */
  onSignal<TSig>(
    signal: MaybeBuilder<SignalNode<TSig>>,
    options: CompactionSignalTriggerOptions<TSig>,
  ): CompactionConfigBuilder;

  /**
   * Registers a terminal exit state compaction trigger for completed runs.
   *
   * Schedules raw wire-frame pruning once a run reaches one of `states` and `options.afterGracePeriodHours` elapses.
   *
   * @param {readonly string[]}             states  - Terminal flow exit states that arm compaction.
   * @param {CompactionTerminalExitOptions} options - Grace period in hours after terminal exit.
   *
   * @returns {CompactionConfigBuilder} Updated immutable compaction configuration builder.
   */
  onTerminalExit(
    states: readonly string[],
    options: CompactionTerminalExitOptions,
  ): CompactionConfigBuilder;

  /**
   * Sets the retention window in days for failed or exhausted runs before raw wire frames are pruned.
   *
   * Preserves failed run wire frames for post-mortem debugging across `days` days.
   *
   * @param {number} days - Positive retention window in days.
   *
   * @returns {CompactionConfigBuilder} Updated immutable compaction configuration builder.
   */
  retainFailedRunsForDays(days: number): CompactionConfigBuilder;
}
