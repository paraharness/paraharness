import type { AgentNode } from '../../../ast/agent-node.js';
import type { StepASTNode } from '../../../ast/domain-ast.types.js';
import type { FlowBranchNode } from '../../../ast/flow-branch-node.js';
import type { FlowStepNode } from '../../../ast/flow-step-node.js';
import type { LoopNode } from '../../../ast/loop-node.js';
import type { PrefixGroupNode } from '../../../ast/prefix-group-node.js';

/**
 * Recursively collects all `AgentNode` instances reachable from a `StepASTNode` (`AgentNode`, `LoopNode`, capabilities, and interrupt handlers) (`SPEC.md` §3.2.1).
 *
 * Ensures `compileRunWirePrefixes` receives every actor, evaluator, adjudicator, replacement, fork, and tournament agent in the flow.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {StepASTNode<unknown, unknown, THandle>}            step    - Root step AST node to inspect.
 * @param {Map<string, AgentNode<unknown, unknown, THandle>>} visited - Deduplicated map of collected `AgentNode`s keyed by `id`.
 */
export function collectExecutableActors<THandle = unknown>(
  step: StepASTNode<unknown, unknown, THandle>,
  visited: Map<string, AgentNode<unknown, unknown, THandle>>,
): void {
  const stepType = (step as { readonly type?: string }).type;
  if (stepType === 'harness:agent') {
    const agent = step as AgentNode<unknown, unknown, THandle>;
    if (visited.has(agent.id)) {
      return;
    }
    visited.set(agent.id, agent);
    for (const fCap of agent.capabilities?.forks ?? []) {
      collectExecutableActors(fCap.childExecutable, visited);
    }
    for (const sCap of agent.capabilities?.speculations ?? []) {
      collectExecutableActors(sCap.workerExecutable, visited);
      collectExecutableActors(sCap.arbiter.actor, visited);
      if (sCap.verifyWinnerWith !== undefined) {
        collectExecutableActors(sCap.verifyWinnerWith.evaluator, visited);
      }
      if (sCap.refineWinnerWhen !== undefined) {
        collectExecutableActors(sCap.refineWinnerWhen.refinementExecutable, visited);
      }
    }
    for (const handler of agent.onInterruptHandlers) {
      if (handler.mode === 'adjudicate') {
        collectExecutableActors(handler.adjudicator, visited);
      }
      if (handler.mode === 'replace') {
        collectExecutableActors(handler.replacementExecutable, visited);
      }
    }
  } else if (stepType === 'harness:loop') {
    const loop = step as LoopNode<unknown, unknown, THandle>;
    collectExecutableActors(loop.actStep.actor, visited);
    collectExecutableActors(loop.evaluateStep.evaluator, visited);
  }
}

/**
 * Collects all deduplicated `AgentNode` definitions across a `FlowNode`'s steps and conditional branches (`SPEC.md` §3.2.1 & §3.9).
 *
 * Walks `FlowStepNode`, `FlowBranchNode`, and step-level `.onInterrupt()` handlers.
 *
 * @template TIn     Validated flow input payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {ReadonlyArray<FlowStepNode<unknown, unknown, THandle> | FlowBranchNode<TIn, unknown, THandle>>} nodes - Flow nodes list.
 *
 * @returns {readonly AgentNode<unknown, unknown, THandle>[]} Deduplicated list of flow actors.
 */
export function collectFlowActors<TIn = unknown, THandle = unknown>(
  nodes: ReadonlyArray<
    FlowStepNode<unknown, unknown, THandle> | FlowBranchNode<TIn, unknown, THandle>
  >,
): readonly AgentNode<unknown, unknown, THandle>[] {
  const visited = new Map<string, AgentNode<unknown, unknown, THandle>>();
  const visitList = (
    items: ReadonlyArray<
      FlowStepNode<unknown, unknown, THandle> | FlowBranchNode<TIn, unknown, THandle>
    >,
  ): void => {
    for (const node of items) {
      if (node.type !== 'harness:flow-step') {
        for (const branchCase of node.cases) {
          visitList(branchCase.steps);
        }
        visitList(node.otherwiseSteps);
        continue;
      }
      collectExecutableActors(node.step, visited);
      for (const handler of node.onInterruptHandlers) {
        if (handler.mode === 'adjudicate') {
          collectExecutableActors(handler.adjudicator, visited);
        } else if (handler.mode === 'replace') {
          collectExecutableActors(handler.replacementExecutable, visited);
        }
      }
    }
  };
  visitList(nodes);
  return Object.freeze(Array.from(visited.values()));
}

/**
 * Collects all unique `PrefixGroupNode` instances referenced by `actors` and `explicitGroups` (`SPEC.md` §3.2.1).
 *
 * Deduplicates by `prefixGroup.id` so `compileRunWirePrefixes` compiles every group mounted on flow actors.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {readonly AgentNode<unknown, unknown, THandle>[]} actors         - Collected flow actors.
 * @param {readonly PrefixGroupNode[] | undefined}          explicitGroups - Optional explicitly configured prefix groups.
 *
 * @returns {readonly PrefixGroupNode[]} Deduplicated prefix group list.
 */
export function collectFlowPrefixGroups<THandle = unknown>(
  actors: readonly AgentNode<unknown, unknown, THandle>[],
  explicitGroups: readonly PrefixGroupNode[] | undefined,
): readonly PrefixGroupNode[] {
  const groupsById = new Map<string, PrefixGroupNode>();
  for (const group of explicitGroups ?? []) {
    groupsById.set(group.id, group);
  }
  for (const actor of actors) {
    if (actor.prefixGroup !== undefined) {
      groupsById.set(actor.prefixGroup.id, actor.prefixGroup);
    }
  }
  return Object.freeze(Array.from(groupsById.values()));
}
