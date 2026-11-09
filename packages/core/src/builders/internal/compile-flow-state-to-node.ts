import type { FlowNode } from '../../ast/flow-node.js';
import { deepFreeze } from './deep-freeze.js';
import type { FlowBuilderState } from './flow-builder-state.js';
import { validateFlowScopeCapabilities } from './validate-flow-capabilities.js';

/**
 * Validates and compiles a `FlowBuilderState` into a deeply frozen `FlowNode`.
 *
 * Ensures `.input(schema)`, `.scope(scope)`, and `.exit(state)` are bound and runs static
 * `capabilityTier` and `effectTracking` validations across all flow steps and branches.
 *
 * @template TIn      Flow input payload type.
 * @template THandle  Isolation scope handle type.
 * @template TStepIds Union of literal step and branch identifiers.
 *
 * @param {FlowBuilderState<TIn, THandle, TStepIds>} state - Current flow builder state.
 *
 * @returns {FlowNode<TIn, THandle, TStepIds>} Deeply frozen `FlowNode`.
 *
 * @throws {Error} If required configuration is missing or scope capability checks fail.
 */
export function compileFlowStateToNode<TIn, THandle, TStepIds extends string>(
  state: FlowBuilderState<TIn, THandle, TStepIds>,
): FlowNode<TIn, THandle, TStepIds> {
  const missing: string[] = [];
  if (state.inputSchema === undefined) missing.push('.input(schema)');
  if (state.scope === undefined) missing.push('.scope(scope)');
  if (state.exitState === undefined) missing.push('.exit(state)');
  if (
    missing.length > 0 ||
    state.inputSchema === undefined ||
    state.scope === undefined ||
    state.exitState === undefined
  ) {
    throw new Error(
      `Flow '${state.id}' is missing required ${missing.join(', ')} configuration before .toAST().`,
    );
  }
  const flowNode = deepFreeze<FlowNode<TIn, THandle, TStepIds>>({
    type: 'harness:flow',
    id: state.id,
    inputSchema: state.inputSchema,
    scope: state.scope,
    telemetry: state.telemetry,
    nodes: state.nodes,
    exitState: state.exitState,
  });
  validateFlowScopeCapabilities(flowNode);
  return flowNode;
}
