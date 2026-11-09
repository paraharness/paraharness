import type { z } from 'zod';
import type { BivariantCallback, MaybeBuilder } from '../../ast/ast-foundation.types.js';
import type { TrackerASTNode } from '../../ast/domain-ast.types.js';
import { extractAST } from '../../ast/extract-ast.js';
import type { FlowNode } from '../../ast/flow-node.js';
import type { HumanNode } from '../../ast/human-node.js';
import type { LaneNode, LaneSignalHandlerConfig } from '../../ast/lane-node.js';
import type { ScopedHumanTargetNode } from '../../ast/scoped-human-target-node.js';
import type { SignalNode } from '../../ast/signal-node.js';
import {
  BudgetApprovalSchema,
  type BudgetApproval,
} from '../../schemas/budget-and-lesson.schema.js';
import type { ExtractTrackerExternal, ExtractTrackerState } from '../flow-extraction.types.js';
import type { LaneBuilder } from '../lane-builder.js';
import type { LaneRetryConfigBuilder as LaneRetryBuilder } from '../lane-retry-config-builder.js';
import type { LaneSignalHandlerBuilder } from '../lane-signal-handler-builder.js';
import type { LaneTrackerConfigBuilder as LaneTrackerBuilder } from '../lane-tracker-config-builder.js';
import {
  collectFlowNodeIds,
  compileLaneStateToNode,
  createLaneRetryFromState,
} from './create-lane-retry-from-state.js';
import { createLaneSignalHandlerFromState } from './create-lane-signal-handler-from-state.js';
import { createLaneTrackerFromState } from './create-lane-tracker-from-state.js';
import { assertNonEmptyIdentifier, deepFreeze } from './deep-freeze.js';
import type { LaneBuilderState } from './lane-builder-state.js';
import { validateBidirectionalHumanChannel } from './validate-agent-and-human-capabilities.js';

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
    input: <TNewIn>(schema: z.ZodType<TNewIn>): LaneBuilder<TNewIn, TStepIds> => {
      const wideFlow: FlowNode<unknown, unknown, TStepIds> | undefined =
        state.flow !== undefined ? { ...state.flow, inputSchema: schema } : undefined;
      const prevTracker = state.tracker;
      const wideState: LaneBuilderState<unknown, TStepIds> = {
        ...state,
        inputSchema: undefined,
        tracker: undefined,
        flow: undefined,
        onSignalHandlers: [],
      };
      return createLaneFromState<TNewIn, TStepIds>({
        ...wideState,
        inputSchema: schema,
        tracker:
          prevTracker !== undefined
            ? {
                ...prevTracker,
                fromIssue: (external: unknown): TNewIn | undefined => {
                  const mapped = prevTracker.fromIssue(external);
                  return mapped !== undefined ? schema.parse(mapped) : undefined;
                },
              }
            : undefined,
        flow: wideFlow !== undefined ? { ...wideFlow, inputSchema: schema } : undefined,
        onSignalHandlers: state.onSignalHandlers.map((handler) => {
          const wideMapper: BivariantCallback<[current: unknown, payload: unknown], unknown> = handler.updateMapper;
          const wideHandler: LaneSignalHandlerConfig<unknown, TStepIds, unknown> = {
            ...handler,
            updateMapper: wideMapper,
          };
          return {
            ...wideHandler,
            updateMapper: (current: TNewIn, payload: unknown): TNewIn => schema.parse(wideMapper(current, payload)),
          };
        }),
      });
    },
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
    flow: <TFlowStepIds extends string>(flow: MaybeBuilder<FlowNode<TIn, unknown, TFlowStepIds>>): LaneBuilder<TIn, TFlowStepIds> => {
      const flowNode = extractAST(flow);
      const knownStepIds = collectFlowNodeIds(flowNode);
      for (const handler of state.onSignalHandlers) {
        if (!knownStepIds.has(handler.rewindToStepId)) {
          throw new Error(
            `Lane '${state.id}' signal handler on '${handler.signal.id}' rewinds to unknown step ID '${handler.rewindToStepId}' not present in flow '${flowNode.id}'.`,
          );
        }
      }
      const wideState: LaneBuilderState<TIn, string> = { ...state, flow: undefined };
      return createLaneFromState<TIn, TFlowStepIds>({ ...wideState, flow: flowNode });
    },
    runs: <TFlowStepIds extends string>(flow: MaybeBuilder<FlowNode<TIn, unknown, TFlowStepIds>>): LaneBuilder<TIn, TFlowStepIds> => {
      const flowNode = extractAST(flow);
      const knownStepIds = collectFlowNodeIds(flowNode);
      for (const handler of state.onSignalHandlers) {
        if (!knownStepIds.has(handler.rewindToStepId)) {
          throw new Error(
            `Lane '${state.id}' signal handler on '${handler.signal.id}' rewinds to unknown step ID '${handler.rewindToStepId}' not present in flow '${flowNode.id}'.`,
          );
        }
      }
      const wideState: LaneBuilderState<TIn, string> = { ...state, flow: undefined };
      return createLaneFromState<TIn, TFlowStepIds>({ ...wideState, flow: flowNode });
    },
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
    waitFor: (depsMapper: (input: TIn) => readonly string[], onAbandonedState: string): LaneBuilder<TIn, TStepIds> => {
      assertNonEmptyIdentifier('P.lane.waitFor', onAbandonedState);
      return createLaneFromState<TIn, TStepIds>({ ...state, waitFor: { depsMapper, onAbandonedState } });
    },
    maxCostUsd: (
      limitUsd: number,
      approver:
        | MaybeBuilder<ScopedHumanTargetNode<BudgetApproval>>
        | MaybeBuilder<HumanNode<'bidirectional'>>
        | MaybeBuilder<HumanNode<'notify-only'>>
        | MaybeBuilder<HumanNode>,
    ): LaneBuilder<TIn, TStepIds> => {
      const extracted = extractAST(approver);
      const approverNode: ScopedHumanTargetNode<BudgetApproval> =
        extracted.type === 'harness:human'
          ? deepFreeze<ScopedHumanTargetNode<BudgetApproval>>({
              type: 'harness:scoped-human',
              human: validateBidirectionalHumanChannel(extracted, 'P.lane.maxCostUsd()'),
              alias: `${extracted.id}:budget-approver`,
              outputSchema: BudgetApprovalSchema,
            })
          : (validateBidirectionalHumanChannel(extracted.human, 'P.lane.maxCostUsd()'), extracted);
      return createLaneFromState<TIn, TStepIds>({ ...state, maxCostUsd: { limitUsd, approver: approverNode } });
    },
    retry: (configure: ($r: LaneRetryBuilder) => LaneRetryBuilder): LaneBuilder<TIn, TStepIds> => {
      const retryConfig = configure(createLaneRetryFromState({ tries: 1, exponentialBaseMs: 1_000, orFailState: 'failed' })).toAST();
      return createLaneFromState<TIn, TStepIds>({ ...state, retry: retryConfig });
    },
    onSignal: <TPayload>(
      signal: MaybeBuilder<SignalNode<TPayload>>,
      configure: ($s: LaneSignalHandlerBuilder<TIn, TStepIds, TPayload>) => LaneSignalHandlerBuilder<TIn, TStepIds, TPayload>,
    ): LaneBuilder<TIn, TStepIds> => {
      const handlerConfig = configure(createLaneSignalHandlerFromState<TIn, TStepIds, TPayload>({ signal: extractAST(signal) })).toAST();
      if (state.flow !== undefined && !state.flow.nodes.some((n) => n.id === handlerConfig.rewindToStepId)) {
        throw new Error(
          `Lane '${state.id}' signal handler on '${handlerConfig.signal.id}' rewinds to unknown step ID '${handlerConfig.rewindToStepId}' not present in flow '${state.flow.id}'.`,
        );
      }
      return createLaneFromState<TIn, TStepIds>({ ...state, onSignalHandlers: [...state.onSignalHandlers, handlerConfig] });
    },
    toAST: (): LaneNode<TIn, TStepIds> => compileLaneStateToNode(state),
  });
}
