import type { TrackerASTNode } from '../../ast/domain-ast.types.js';
import type { LaneTrackerConfig } from '../../ast/lane-node.js';
import type { LaneTrackerBuilder } from '../lane-tracker-config-builder.js';
import { createLaneRetryFromState } from './create-lane-retry-from-state.js';
import { createLaneSignalHandlerFromState } from './create-lane-signal-handler-from-state.js';
import { deepFreeze } from './deep-freeze.js';

export { createLaneRetryFromState, createLaneSignalHandlerFromState };

/**
 * Creates an immutable `LaneTrackerBuilder` from an internal state snapshot.
 *
 * Configures polling cadence, external issue-to-input projection, and lifecycle state
 * transition mappings for a lane's external issue tracker adapter.
 *
 * @template TIn            Validated lane work item input type.
 * @template TExternal      Raw external issue payload type.
 * @template TExternalState External tracker state string type.
 *
 * @param {object} state - Current tracker builder state.
 *
 * @returns {LaneTrackerBuilder<TIn, TExternal, TExternalState>} Frozen tracker builder.
 */
export function createLaneTrackerFromState<
  TIn = unknown,
  TExternal = unknown,
  TExternalState extends string = string,
>(state: {
  readonly adapter: TrackerASTNode;
  readonly everySeconds: number;
  readonly fromIssue?: (external: TExternal) => TIn | undefined;
  readonly stateMappings: Readonly<Record<string, string>>;
}): LaneTrackerBuilder<TIn, TExternal, TExternalState> {
  return Object.freeze<LaneTrackerBuilder<TIn, TExternal, TExternalState>>({
    everySeconds(seconds: number): LaneTrackerBuilder<TIn, TExternal, TExternalState> {
      return createLaneTrackerFromState<TIn, TExternal, TExternalState>({
        ...state,
        everySeconds: seconds,
      });
    },
    from(
      mapper: (external: TExternal) => TIn | undefined,
    ): LaneTrackerBuilder<TIn, TExternal, TExternalState> {
      return createLaneTrackerFromState<TIn, TExternal, TExternalState>({
        ...state,
        fromIssue: mapper,
      });
    },
    onQueued(externalState: TExternalState): LaneTrackerBuilder<TIn, TExternal, TExternalState> {
      return createLaneTrackerFromState<TIn, TExternal, TExternalState>({
        ...state,
        stateMappings: { ...state.stateMappings, queued: externalState },
      });
    },
    onRunning(externalState: TExternalState): LaneTrackerBuilder<TIn, TExternal, TExternalState> {
      return createLaneTrackerFromState<TIn, TExternal, TExternalState>({
        ...state,
        stateMappings: { ...state.stateMappings, running: externalState },
      });
    },
    onWaiting(externalState: TExternalState): LaneTrackerBuilder<TIn, TExternal, TExternalState> {
      return createLaneTrackerFromState<TIn, TExternal, TExternalState>({
        ...state,
        stateMappings: { ...state.stateMappings, waiting: externalState },
      });
    },
    onErrored(externalState: TExternalState): LaneTrackerBuilder<TIn, TExternal, TExternalState> {
      return createLaneTrackerFromState<TIn, TExternal, TExternalState>({
        ...state,
        stateMappings: { ...state.stateMappings, errored: externalState },
      });
    },
    onCancelled(externalState: TExternalState): LaneTrackerBuilder<TIn, TExternal, TExternalState> {
      return createLaneTrackerFromState<TIn, TExternal, TExternalState>({
        ...state,
        stateMappings: { ...state.stateMappings, cancelled: externalState },
      });
    },
    onExit(
      exitState: string,
      externalState: TExternalState,
    ): LaneTrackerBuilder<TIn, TExternal, TExternalState> {
      return createLaneTrackerFromState<TIn, TExternal, TExternalState>({
        ...state,
        stateMappings: {
          ...state.stateMappings,
          [`exit:${exitState}`]: externalState,
        },
      });
    },
    toAST(): LaneTrackerConfig<TIn, TExternal> {
      if (state.fromIssue === undefined) {
        throw new Error('Lane tracker configuration requires .from(mapper).');
      }
      return deepFreeze<LaneTrackerConfig<TIn, TExternal>>({
        adapter: state.adapter,
        everySeconds: state.everySeconds,
        fromIssue: state.fromIssue,
        stateMappings: state.stateMappings,
      });
    },
  });
}
