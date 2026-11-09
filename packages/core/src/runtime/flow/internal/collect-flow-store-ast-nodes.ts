import type { AgentNode } from '../../../ast/agent-node.js';
import type { StepASTNode } from '../../../ast/domain-ast.types.js';
import type { FlowBranchNode } from '../../../ast/flow-branch-node.js';
import type { FlowNode } from '../../../ast/flow-node.js';
import type { FlowStepNode } from '../../../ast/flow-step-node.js';
import type { HumanNode } from '../../../ast/human-node.js';
import type { InterruptHandlerNode } from '../../../ast/interrupt-handler-node.types.js';
import type { LessonsNode } from '../../../ast/lessons-node.js';
import type { SpeculateCapabilityNode } from '../../../ast/speculate-capability-node.js';
import type { TopologyNode } from '../../../ast/topology-node.js';

/**
 * Mutable accumulator state passed through step and flow AST store-node traversal (`SPEC.md` §3.1 & §3.9).
 */
export interface CollectStepStoreNodesParams {
  /** Set of already-visited step identifiers guarding against cyclic graph traversal. */
  readonly visited: Set<string>;

  /** Discovered `TopologyNode` definitions keyed by `topology.id` in declaration order. */
  readonly topologiesById: Map<string, TopologyNode<string>>;

  /** Discovered `LessonsNode` definitions keyed by `lessons.id` in declaration order. */
  readonly lessonsById: Map<string, LessonsNode>;

  /** Discovered `HumanNode` definitions keyed by `human.id` in declaration order. */
  readonly humansById: Map<
    string,
    HumanNode<'bidirectional'> | HumanNode<'notify-only'> | HumanNode
  >;
}

/**
 * Input parameters for `collectFlowStoreAstNodes` (`SPEC.md` §3.1 & §3.9).
 */
export interface CollectFlowStoreAstNodesParams {
  /** Flow AST nodes to traverse. */
  readonly flows: readonly FlowNode<unknown, unknown>[];

  /** Optional additional human channel nodes declared at the harness or lane level. */
  readonly extraHumans?: ReadonlyArray<
    HumanNode<'bidirectional'> | HumanNode<'notify-only'> | HumanNode
  >;

  /** Optional pre-supplied topology AST node override. */
  readonly existingTopologyNode?: TopologyNode<string>;
}

/**
 * Recursively collects `HumanNode`, `TopologyNode`, and `LessonsNode` declarations across interrupt handler edges (`ask`, `adjudicate`, and `replace`).
 *
 * @param {readonly InterruptHandlerNode<unknown, unknown, unknown>[]} handlers - Interrupt handler edges to inspect.
 * @param {CollectStepStoreNodesParams}                                state    - Mutable traversal accumulator.
 */
function collectInterruptHandlerStoreNodes(
  handlers: readonly InterruptHandlerNode<unknown, unknown, unknown>[],
  state: CollectStepStoreNodesParams,
): void {
  for (const handler of handlers) {
    if (handler.mode === 'ask') {
      state.humansById.set(handler.human.id, handler.human);
    } else if (handler.mode === 'adjudicate') {
      collectStepStoreNodes(handler.adjudicator, state);
      collectInterruptHandlerStoreNodes(handler.onInterruptHandlers, state);
    } else if (handler.mode === 'replace') {
      collectStepStoreNodes(handler.replacementExecutable, state);
    }
  }
}

/**
 * Collects store and human nodes from a `SpeculateCapabilityNode` (`workerExecutable`, `arbiter.actor`, `verifyWinnerWith`, and `refineWinnerWhen`).
 *
 * @param {SpeculateCapabilityNode}     sCap  - Speculative tournament capability node.
 * @param {CollectStepStoreNodesParams} state - Mutable traversal accumulator.
 */
function collectSpeculateStoreNodes(
  sCap: SpeculateCapabilityNode,
  state: CollectStepStoreNodesParams,
): void {
  collectStepStoreNodes(sCap.workerExecutable, state);
  collectStepStoreNodes(sCap.arbiter.actor, state);
  if (sCap.verifyWinnerWith !== undefined) {
    collectStepStoreNodes(sCap.verifyWinnerWith.evaluator, state);
  }
  if (sCap.refineWinnerWhen !== undefined) {
    collectStepStoreNodes(sCap.refineWinnerWhen.refinementExecutable, state);
  }
}

/**
 * Collects `TopologyNode`, `LessonsNode`, and `HumanNode` declarations from an `AgentNode` and its capabilities and interrupt edges.
 *
 * @param {AgentNode<unknown, unknown, unknown>} step  - Agent AST node to inspect.
 * @param {CollectStepStoreNodesParams}          state - Mutable traversal accumulator.
 */
function collectAgentStoreNodes(
  step: AgentNode<unknown, unknown, unknown>,
  state: CollectStepStoreNodesParams,
): void {
  const visitKey = `agent:${step.id}:${step.roleKey}`;
  if (state.visited.has(visitKey)) {
    return;
  }
  state.visited.add(visitKey);
  if (step.topology !== undefined) {
    state.topologiesById.set(step.topology.id, step.topology);
  }
  if (step.lessons !== undefined) {
    state.lessonsById.set(step.lessons.node.id, step.lessons.node);
  }
  const mutateTopo = step.capabilities?.mutatePlan?.topologyToUpdate;
  if (mutateTopo !== undefined) {
    state.topologiesById.set(mutateTopo.id, mutateTopo);
  }
  for (const esc of step.capabilities?.escalations ?? []) {
    state.humansById.set(esc.human.id, esc.human);
  }
  for (const fCap of step.capabilities?.forks ?? []) {
    collectStepStoreNodes(fCap.childExecutable, state);
  }
  for (const sCap of step.capabilities?.speculations ?? []) {
    collectSpeculateStoreNodes(sCap, state);
  }
  collectInterruptHandlerStoreNodes(step.onInterruptHandlers, state);
}

/**
 * Recursively collects `TopologyNode`, `LessonsNode`, and `HumanNode` declarations from a `StepASTNode`.
 *
 * @param {StepASTNode<unknown, unknown, unknown>} step  - Step AST node to traverse.
 * @param {CollectStepStoreNodesParams}            state - Mutable traversal accumulator.
 */
function collectStepStoreNodes(
  step: StepASTNode<unknown, unknown, unknown>,
  state: CollectStepStoreNodesParams,
): void {
  if (step.type === 'harness:agent') {
    collectAgentStoreNodes(step, state);
    return;
  }
  if (step.type !== 'harness:loop') {
    return;
  }
  const visitKey = `loop:${step.id}`;
  if (state.visited.has(visitKey)) {
    return;
  }
  state.visited.add(visitKey);
  if (step.distillLessons !== undefined) {
    state.lessonsById.set(step.distillLessons.id, step.distillLessons);
  }
  collectStepStoreNodes(step.actStep.actor, state);
  collectStepStoreNodes(step.evaluateStep.evaluator, state);
}

/**
 * Recursively traverses flow steps and branches, collecting store and human AST nodes from steps and flow-step interrupt edges.
 *
 * @param {ReadonlyArray<FlowStepNode<unknown, unknown, unknown> | FlowBranchNode<unknown, unknown, unknown>>} items - Flow steps and branches.
 * @param {CollectStepStoreNodesParams}                                                                        state - Mutable traversal accumulator.
 */
function visitFlowNodeList(
  items: ReadonlyArray<
    FlowStepNode<unknown, unknown, unknown> | FlowBranchNode<unknown, unknown, unknown>
  >,
  state: CollectStepStoreNodesParams,
): void {
  for (const item of items) {
    if (item.type === 'harness:flow-step') {
      collectStepStoreNodes(item.step, state);
      collectInterruptHandlerStoreNodes(item.onInterruptHandlers, state);
      continue;
    }
    for (const branchCase of item.cases) {
      visitFlowNodeList(branchCase.steps, state);
    }
    visitFlowNodeList(item.otherwiseSteps, state);
  }
}

/**
 * Traverses one or more `FlowNode` AST trees and returns all deduplicated `TopologyNode`, `LessonsNode`, and `HumanNode` declarations (`SPEC.md` §3.1 & §3.9).
 *
 * @param {CollectFlowStoreAstNodesParams} params - Flows, extra human nodes, and optional pre-supplied topology node.
 *
 * @returns {{ readonly primaryTopologyNode: TopologyNode<string> | undefined; readonly topologiesById: ReadonlyMap<string, TopologyNode<string>>; readonly primaryLessonsNode: LessonsNode | undefined; readonly lessonsById: ReadonlyMap<string, LessonsNode>; readonly humansById: ReadonlyMap<string, HumanNode<'bidirectional'> | HumanNode<'notify-only'> | HumanNode> }} Collected store and human AST nodes.
 */
export function collectFlowStoreAstNodes(params: CollectFlowStoreAstNodesParams): {
  readonly primaryTopologyNode: TopologyNode<string> | undefined;
  readonly topologiesById: ReadonlyMap<string, TopologyNode<string>>;
  readonly primaryLessonsNode: LessonsNode | undefined;
  readonly lessonsById: ReadonlyMap<string, LessonsNode>;
  readonly humansById: ReadonlyMap<
    string,
    HumanNode<'bidirectional'> | HumanNode<'notify-only'> | HumanNode
  >;
} {
  const state: CollectStepStoreNodesParams = {
    visited: new Set<string>(),
    topologiesById: new Map<string, TopologyNode<string>>(),
    lessonsById: new Map<string, LessonsNode>(),
    humansById: new Map<
      string,
      HumanNode<'bidirectional'> | HumanNode<'notify-only'> | HumanNode
    >(),
  };
  if (params.existingTopologyNode !== undefined) {
    state.topologiesById.set(params.existingTopologyNode.id, params.existingTopologyNode);
  }
  for (const h of params.extraHumans ?? []) {
    state.humansById.set(h.id, h);
  }
  for (const flow of params.flows) {
    visitFlowNodeList(flow.nodes, state);
  }
  const primaryTopologyNode =
    params.existingTopologyNode ?? state.topologiesById.values().next().value;
  const primaryLessonsNode = state.lessonsById.values().next().value;
  return {
    primaryTopologyNode,
    topologiesById: state.topologiesById,
    primaryLessonsNode,
    lessonsById: state.lessonsById,
    humansById: state.humansById,
  };
}
