import type { FlowNode } from '../../ast/flow-node.js';
import type { LaneNode, LaneRetryConfig } from '../../ast/lane-node.js';
import type { LaneRetryConfigBuilder as LaneRetryBuilder } from '../lane-retry-config-builder.js';
import { deepFreeze } from './deep-freeze.js';
import type { LaneBuilderState } from './lane-builder-state.js';

/**
 * Collects the set of top-level step and branch identifiers registered on a `FlowNode`.
 *
 * Used to validate `.onSignal().rewindTo(stepId)` targets when binding a flow or compiling a lane.
 *
 * @param {FlowNode<unknown, unknown, string>} flow - Target flow AST node.
 *
 * @returns {ReadonlySet<string>} Set of step and branch IDs present in `flow.nodes`.
 */
export function collectFlowNodeIds(flow: FlowNode<unknown, unknown, string>): ReadonlySet<string> {
  const knownStepIds = new Set<string>();
  for (const node of flow.nodes) {
    knownStepIds.add(node.id);
  }
  return knownStepIds;
}

/**
 * Creates an immutable `LaneRetryBuilder` from an internal state snapshot.
 *
 * Captures maximum attempt count, exponential backoff base interval in milliseconds,
 * and terminal failure tracker state for lane execution retries.
 *
 * @param {{ tries: number; exponentialBaseMs: number; orFailState: string }} state - Current retry builder state.
 *
 * @returns {LaneRetryBuilder} Frozen retry builder.
 */
export function createLaneRetryFromState(state: {
  readonly tries: number;
  readonly exponentialBaseMs: number;
  readonly orFailState: string;
}): LaneRetryBuilder {
  return Object.freeze<LaneRetryBuilder>({
    tries(count: number): LaneRetryBuilder {
      return createLaneRetryFromState({ ...state, tries: count });
    },
    exponential(baseMs: number): LaneRetryBuilder {
      return createLaneRetryFromState({ ...state, exponentialBaseMs: baseMs });
    },
    orFail(failState: string): LaneRetryBuilder {
      return createLaneRetryFromState({ ...state, orFailState: failState });
    },
    toAST(): LaneRetryConfig {
      return deepFreeze<LaneRetryConfig>({
        tries: state.tries,
        exponentialBaseMs: state.exponentialBaseMs,
        orFailState: state.orFailState,
      });
    },
  });
}

/**
 * Validates and compiles a `LaneBuilderState` into a deeply frozen `LaneNode`.
 *
 * Verifies that `.input()`, `.key()`, and `.flow()` are configured and that every
 * `.onSignal()` rewind target references a valid step or branch ID in the bound flow.
 *
 * @template TIn      Lane work item input type.
 * @template TStepIds Union of literal step and branch IDs in the lane's flow.
 *
 * @param {LaneBuilderState<TIn, TStepIds>} state - Current lane builder state.
 *
 * @returns {LaneNode<TIn, TStepIds>} Deeply frozen `LaneNode`.
 */
export function compileLaneStateToNode<TIn, TStepIds extends string>(
  state: LaneBuilderState<TIn, TStepIds>,
): LaneNode<TIn, TStepIds> {
  if (state.inputSchema === undefined || state.keyMapper === undefined || state.flow === undefined) {
    throw new Error(
      `Lane '${state.id}' is missing required .input(schema), .key(mapper), or .flow(flow) configuration.`,
    );
  }
  const knownStepIds = collectFlowNodeIds(state.flow);
  for (const handler of state.onSignalHandlers) {
    if (!knownStepIds.has(handler.rewindToStepId)) {
      throw new Error(
        `Lane '${state.id}' signal handler on '${handler.signal.id}' rewinds to unknown step ID '${handler.rewindToStepId}' not present in flow '${state.flow.id}'.`,
      );
    }
  }
  return deepFreeze<LaneNode<TIn, TStepIds>>({
    type: 'harness:lane',
    id: state.id,
    inputSchema: state.inputSchema,
    keyMapper: state.keyMapper,
    tracker: state.tracker,
    flow: state.flow,
    concurrency: state.concurrency,
    priority: state.priority,
    agingMinutes: state.agingMinutes,
    waitFor: state.waitFor,
    maxCostUsd: state.maxCostUsd,
    retry: state.retry,
    onSignalHandlers: state.onSignalHandlers,
  });
}
