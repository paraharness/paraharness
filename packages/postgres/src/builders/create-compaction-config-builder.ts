import {
  type CompactionConfigNode,
  type CompactionSignalTrigger,
  type CompactionTerminalExitTrigger,
  type MaybeBuilder,
  type SignalNode,
  extractAST,
} from '@metaharness/core';
import type {
  CompactionConfigBuilder,
  CompactionSignalTriggerOptions,
  CompactionTerminalExitOptions,
} from './compaction-config-builder.js';
import type { CompactionConfigBuilderState } from './internal/compaction-config-builder-state.js';

/**
 * Creates an immutable `CompactionConfigBuilder` instance for PostgreSQL ledger wire-frame pruning policies.
 *
 * Provides copy-on-write methods for configuring signal-correlated compaction triggers,
 * terminal-state compaction triggers, and failed-run retention windows without side effects.
 *
 * @param {CompactionConfigBuilderState} [state] - Optional internal copy-on-write builder state.
 *
 * @returns {CompactionConfigBuilder} Frozen compaction configuration builder.
 */
export function createCompactionConfigBuilder(
  state?: CompactionConfigBuilderState,
): CompactionConfigBuilder {
  const signalTriggers: readonly CompactionSignalTrigger[] = state?.signalTriggers ?? [];
  const terminalExitTriggers: readonly CompactionTerminalExitTrigger[] =
    state?.terminalExitTriggers ?? [];
  const retainFailedRunsForDays = state?.retainFailedRunsForDays;

  return Object.freeze<CompactionConfigBuilder>({
    onSignal<TSig>(
      signal: MaybeBuilder<SignalNode<TSig>>,
      options: CompactionSignalTriggerOptions<TSig>,
    ): CompactionConfigBuilder {
      if (!Number.isFinite(options.afterGracePeriodHours) || options.afterGracePeriodHours < 0) {
        throw new Error(
          `Invalid compaction afterGracePeriodHours '${String(options.afterGracePeriodHours)}': expected a non-negative finite number.`,
        );
      }
      const nextTrigger = Object.freeze<CompactionSignalTrigger<TSig>>({
        signal: extractAST(signal),
        correlateBy: options.correlateBy,
        afterGracePeriodHours: options.afterGracePeriodHours,
      });
      return createCompactionConfigBuilder({
        signalTriggers: Object.freeze([...signalTriggers, nextTrigger]),
        terminalExitTriggers,
        retainFailedRunsForDays,
      });
    },
    onTerminalExit(
      states: readonly string[],
      options: CompactionTerminalExitOptions,
    ): CompactionConfigBuilder {
      if (!Number.isFinite(options.afterGracePeriodHours) || options.afterGracePeriodHours < 0) {
        throw new Error(
          `Invalid compaction afterGracePeriodHours '${String(options.afterGracePeriodHours)}': expected a non-negative finite number.`,
        );
      }
      const nextTrigger = Object.freeze<CompactionTerminalExitTrigger>({
        states: Object.freeze([...states]),
        afterGracePeriodHours: options.afterGracePeriodHours,
      });
      return createCompactionConfigBuilder({
        signalTriggers,
        terminalExitTriggers: Object.freeze([...terminalExitTriggers, nextTrigger]),
        retainFailedRunsForDays,
      });
    },
    retainFailedRunsForDays(days: number): CompactionConfigBuilder {
      if (!Number.isFinite(days) || days <= 0) {
        throw new Error(
          `Invalid retainFailedRunsForDays '${String(days)}': expected a positive finite number.`,
        );
      }
      return createCompactionConfigBuilder({
        signalTriggers,
        terminalExitTriggers,
        retainFailedRunsForDays: days,
      });
    },
    toAST(): CompactionConfigNode {
      return Object.freeze<CompactionConfigNode>({
        type: 'harness:compaction',
        signalTriggers: Object.freeze([...signalTriggers]),
        terminalExitTriggers: Object.freeze([...terminalExitTriggers]),
        retainFailedRunsForDays,
      });
    },
  });
}
