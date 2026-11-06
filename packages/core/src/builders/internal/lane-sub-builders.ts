import type { z } from 'zod';
import type { MaybeBuilder } from '../../ast/ast-foundation.types.js';
import type { TrackerASTNode } from '../../ast/domain-ast.types.js';
import { extractAST } from '../../ast/extract-ast.js';
import type { FlowNode } from '../../ast/flow-node.js';
import type { LaneNode } from '../../ast/lane-node.js';
import type { ScopedHumanTargetNode } from '../../ast/scoped-human-target-node.js';
import type { SignalNode } from '../../ast/signal-node.js';
import type { BudgetApproval } from '../../schemas/budget-and-lesson.schema.js';
import type {
  ExtractTrackerExternal,
  ExtractTrackerState,
} from '../flow-extraction.types.js';
import type { LaneBuilder } from '../lane-builder.js';
import type { LaneRetryBuilder } from '../lane-retry-config-builder.js';
import type { LaneSignalHandlerBuilder } from '../lane-signal-handler-builder.js';
import type { LaneTrackerBuilder } from '../lane-tracker-config-builder.js';
import {
  compileLaneStateToNode,
  createLaneRetryFromState,
} from './create-lane-retry-from-state.js';
import { createLaneSignalHandlerFromState } from './create-lane-signal-handler-from-state.js';
import { assertNonEmptyIdentifier } from './deep-freeze.js';
import type { LaneBuilderState } from './lane-builder-state.js';
import { createLaneTrackerFromState } from './lane-config-sub-builders.js';
import { validateBidirectionalHumanChannel } from './validate-flow-capabilities.js';

export type { LaneBuilderState } from './lane-builder-state.js';

/**
 * Creates an immutable `LaneBuilder` from an internal state snapshot.
 *
 * Provides copy-on-write fluent methods for configuring lane input validation,
 * deduplication keys, issue trackers, flow binding, concurrency, priority aging,
 * cost ceilings, retries, and live signal rewind handlers.
 *
 * @template TIn      Validated lane work item input type.
 * @template TStepIds Union of literal step and branch IDs in the bound `FlowNode`.
 *
 * @param {LaneBuilderState<TIn, TStepIds>} state - Current lane builder state.
 *
 * @returns {LaneBuilder<TIn, TStepIds>} Frozen lane builder.
 */
export function createLaneFromState<TIn = unknown, TStepIds extends string = string>(
  state: LaneBuilderState<TIn, TStepIds>,
): LaneBuilder<TIn, TStepIds> {
  return Object.freeze<LaneBuilder<TIn, TStepIds>>({
    id: state.id,
    input: <TNewIn>(
      schema: z.ZodType<TNewIn, z.ZodTypeDef, unknown>,
    ): LaneBuilder<TNewIn, TStepIds> =>
      createLaneFromState<TNewIn, TStepIds>({
        ...state,
        inputSchema: schema,
        keyMapper: undefined,
        tracker: undefined,
        flow: undefined,
        waitFor: undefined,
        onSignalHandlers: [],
      }),
    key: (mapper: (input: TIn) => string): LaneBuilder<TIn, TStepIds> =>
      createLaneFromState<TIn, TStepIds>({ ...state, keyMapper: mapper }),
    tracker: <TAdapter extends TrackerASTNode>(
      adapter: MaybeBuilder<TAdapter>,
      configure: (
        $t: LaneTrackerBuilder<TIn, ExtractTrackerExternal<TAdapter>, ExtractTrackerState<TAdapter>>,
      ) => LaneTrackerBuilder<TIn, ExtractTrackerExternal<TAdapter>, ExtractTrackerState<TAdapter>>,
    ): LaneBuilder<TIn, TStepIds> => {
      const trackerConfig = configure(
        createLaneTrackerFromState<TIn, ExtractTrackerExternal<TAdapter>, ExtractTrackerState<TAdapter>>({
          adapter: extractAST(adapter),
          everySeconds: 60,
          stateMappings: {},
        }),
      ).toAST();
      return createLaneFromState<TIn, TStepIds>({ ...state, tracker: trackerConfig });
    },
    flow: <TFlowStepIds extends string>(
      flow: MaybeBuilder<FlowNode<TIn, unknown, TFlowStepIds>>,
    ): LaneBuilder<TIn, TFlowStepIds> =>
      createLaneFromState<TIn, TFlowStepIds>({
        ...state,
        flow: extractAST(flow),
        onSignalHandlers: [],
      }),
    runs: <TFlowStepIds extends string>(
      flow: MaybeBuilder<FlowNode<TIn, unknown, TFlowStepIds>>,
    ): LaneBuilder<TIn, TFlowStepIds> =>
      createLaneFromState<TIn, TFlowStepIds>({
        ...state,
        flow: extractAST(flow),
        onSignalHandlers: [],
      }),
    concurrency: (limit: number): LaneBuilder<TIn, TStepIds> => {
      if (!Number.isInteger(limit) || limit < 1) {
        throw new Error(`Lane '${state.id}' requires concurrency >= 1 (received ${limit}).`);
      }
      return createLaneFromState<TIn, TStepIds>({ ...state, concurrency: limit });
    },
    priority: (level: 'low' | 'normal' | 'high' | 'critical'): LaneBuilder<TIn, TStepIds> =>
      createLaneFromState<TIn, TStepIds>({ ...state, priority: level }),
    agingMinutes: (minutes: number): LaneBuilder<TIn, TStepIds> =>
      createLaneFromState<TIn, TStepIds>({ ...state, agingMinutes: minutes }),
    waitFor: (
      depsMapper: (input: TIn) => readonly string[],
      onAbandonedState: string,
    ): LaneBuilder<TIn, TStepIds> => {
      assertNonEmptyIdentifier('H.lane.waitFor', onAbandonedState);
      return createLaneFromState<TIn, TStepIds>({
        ...state,
        waitFor: { depsMapper, onAbandonedState },
      });
    },
    maxCostUsd: (
      limitUsd: number,
      approver: MaybeBuilder<ScopedHumanTargetNode<BudgetApproval>>,
    ): LaneBuilder<TIn, TStepIds> => {
      const approverNode = extractAST(approver);
      validateBidirectionalHumanChannel(approverNode.human, 'H.lane.maxCostUsd()');
      return createLaneFromState<TIn, TStepIds>({
        ...state,
        maxCostUsd: { limitUsd, approver: approverNode },
      });
    },
    retry: (configure: ($r: LaneRetryBuilder) => LaneRetryBuilder): LaneBuilder<TIn, TStepIds> => {
      const retryConfig = configure(
        createLaneRetryFromState({
          tries: 1,
          exponentialBaseMs: 1_000,
          orFailState: 'failed',
        }),
      ).toAST();
      return createLaneFromState<TIn, TStepIds>({ ...state, retry: retryConfig });
    },
    onSignal: <TPayload>(
      signal: MaybeBuilder<SignalNode<TPayload>>,
      configure: (
        $s: LaneSignalHandlerBuilder<TIn, TStepIds, TPayload>,
      ) => LaneSignalHandlerBuilder<TIn, TStepIds, TPayload>,
    ): LaneBuilder<TIn, TStepIds> => {
      const handlerConfig = configure(
        createLaneSignalHandlerFromState<TIn, TStepIds, TPayload>({
          signal: extractAST(signal),
        }),
      ).toAST();
      if (state.flow !== undefined) {
        const stepExists = state.flow.nodes.some((n) => n.id === handlerConfig.rewindToStepId);
        if (!stepExists) {
          throw new Error(
            `Lane '${state.id}' signal handler on '${handlerConfig.signal.id}' rewinds to unknown step ID '${handlerConfig.rewindToStepId}' not present in flow '${state.flow.id}'.`,
          );
        }
      }
      return createLaneFromState<TIn, TStepIds>({
        ...state,
        onSignalHandlers: [...state.onSignalHandlers, handlerConfig],
      });
    },
    toAST: (): LaneNode<TIn, TStepIds> => compileLaneStateToNode(state),
  });
}
