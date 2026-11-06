import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type {
  CompactionConfigNode,
  CompactionSignalTrigger,
  CompactionTerminalExitTrigger,
} from '../ast/compaction-config-node.js';
import { extractAST } from '../ast/extract-ast.js';
import type { SignalNode } from '../ast/signal-node.js';
import type { CompactionConfigBuilder } from './compaction-config-builder.js';
import type { CompactionConfigBuilderState } from './internal/compaction-config-builder-state.js';
import { deepFreeze } from './internal/deep-freeze.js';

/**
 * Creates a fluent `CompactionConfigBuilder` instance from an optional state snapshot.
 *
 * Provides copy-on-write methods for configuring signal-correlated compaction triggers,
 * terminal-state compaction triggers, and failed-run retention windows.
 *
 * @param {CompactionConfigBuilderState} [state] - Optional internal copy-on-write state.
 *
 * @returns {CompactionConfigBuilder} Frozen compaction configuration builder.
 */
export function createCompactionConfigBuilder(
  state?: CompactionConfigBuilderState,
): CompactionConfigBuilder {
  const signalTriggers = state?.signalTriggers ?? [];
  const terminalExitTriggers = state?.terminalExitTriggers ?? [];

  return Object.freeze<CompactionConfigBuilder>({
    onSignal<TSig>(
      signal: MaybeBuilder<SignalNode<TSig>>,
      options: {
        readonly correlateBy: (sig: TSig) => string;
        readonly afterGracePeriodHours: number;
      },
    ): CompactionConfigBuilder {
      const trigger: CompactionSignalTrigger<TSig> = {
        signal: extractAST(signal),
        correlateBy: options.correlateBy,
        afterGracePeriodHours: options.afterGracePeriodHours,
      };
      return createCompactionConfigBuilder({
        ...state,
        signalTriggers: [...signalTriggers, trigger],
      });
    },
    onTerminalExit(
      states: readonly string[],
      options: { readonly afterGracePeriodHours: number },
    ): CompactionConfigBuilder {
      const trigger: CompactionTerminalExitTrigger = {
        states: [...states],
        afterGracePeriodHours: options.afterGracePeriodHours,
      };
      return createCompactionConfigBuilder({
        ...state,
        terminalExitTriggers: [...terminalExitTriggers, trigger],
      });
    },
    retainFailedRunsForDays(days: number): CompactionConfigBuilder {
      return createCompactionConfigBuilder({
        ...state,
        retainFailedRunsForDays: days,
      });
    },
    toAST(): CompactionConfigNode {
      return deepFreeze<CompactionConfigNode>({
        type: 'harness:compaction',
        signalTriggers,
        terminalExitTriggers,
        retainFailedRunsForDays: state?.retainFailedRunsForDays,
      });
    },
  });
}
