import type { MaybeBuilder } from '../../ast/ast-foundation.types.js';
import type { ScopeRewindHookASTNode } from '../../ast/domain-ast.types.js';
import { extractAST } from '../../ast/extract-ast.js';
import type { LaneSignalHandlerConfig } from '../../ast/lane-node.js';
import type { SignalNode } from '../../ast/signal-node.js';
import type { LaneSignalHandlerBuilder } from '../lane-signal-handler-builder.js';
import { deepFreeze } from './deep-freeze.js';

/**
 * Creates an immutable `LaneSignalHandlerBuilder` from an internal state snapshot.
 *
 * Captures the live input update mapper, target step ID for rewind, and optional
 * scope rewind hook for handling external signals on an active lane run.
 *
 * @template TIn      Lane work item input type.
 * @template TStepIds Union of literal step and branch IDs in the lane's flow.
 * @template TPayload Signal payload type.
 *
 * @param {object} state - Current signal handler builder state.
 *
 * @returns {LaneSignalHandlerBuilder<TIn, TStepIds, TPayload>} Frozen signal handler builder.
 */
export function createLaneSignalHandlerFromState<
  TIn = unknown,
  TStepIds extends string = string,
  TPayload = unknown,
>(state: {
  readonly signal: SignalNode<TPayload>;
  readonly updateMapper?: (current: TIn, payload: TPayload) => TIn;
  readonly rewindToStepId?: TStepIds;
  readonly onRewind?: ScopeRewindHookASTNode<unknown>;
}): LaneSignalHandlerBuilder<TIn, TStepIds, TPayload> {
  return Object.freeze<LaneSignalHandlerBuilder<TIn, TStepIds, TPayload>>({
    update(
      mapper: (current: TIn, payload: TPayload) => TIn,
    ): LaneSignalHandlerBuilder<TIn, TStepIds, TPayload> {
      return createLaneSignalHandlerFromState<TIn, TStepIds, TPayload>({
        ...state,
        updateMapper: mapper,
      });
    },
    rewindTo(
      stepId: TStepIds,
      options?: { readonly onRewind?: MaybeBuilder<ScopeRewindHookASTNode<unknown>> },
    ): LaneSignalHandlerBuilder<TIn, TStepIds, TPayload> {
      return createLaneSignalHandlerFromState<TIn, TStepIds, TPayload>({
        ...state,
        rewindToStepId: stepId,
        onRewind: options?.onRewind !== undefined ? extractAST(options.onRewind) : undefined,
      });
    },
    toAST(): LaneSignalHandlerConfig<TIn, TStepIds, TPayload> {
      if (state.updateMapper === undefined || state.rewindToStepId === undefined) {
        throw new Error(
          `Lane signal handler on '${state.signal.id}' requires both .update(mapper) and .rewindTo(stepId).`,
        );
      }
      return deepFreeze<LaneSignalHandlerConfig<TIn, TStepIds, TPayload>>({
        signal: state.signal,
        updateMapper: state.updateMapper,
        rewindToStepId: state.rewindToStepId,
        onRewind: state.onRewind,
      });
    },
  });
}
