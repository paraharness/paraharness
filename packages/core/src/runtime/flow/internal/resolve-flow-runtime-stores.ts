import type { StepASTNode } from '../../../ast/domain-ast.types.js';
import type { FlowBranchNode } from '../../../ast/flow-branch-node.js';
import type { FlowNode } from '../../../ast/flow-node.js';
import type { FlowStepNode } from '../../../ast/flow-step-node.js';
import type { HumanNode } from '../../../ast/human-node.js';
import type { InterruptHandlerNode } from '../../../ast/interrupt-handler-node.types.js';
import type { LessonsNode } from '../../../ast/lessons-node.js';
import type { TopologyNode } from '../../../ast/topology-node.js';
import type { HumanAdapter } from '../../../ports/human-adapter.js';
import type { LessonStore } from '../../../ports/lesson-store.js';
import type { RuntimeDriverContext } from '../../../ports/runtime-driver-context.js';
import type { RuntimeExecutorRegistry } from '../../../ports/runtime-executor-registry.js';
import type { TopologyStore } from '../../../ports/topology-store.js';

/**
 * Parameters passed to `resolveFlowRuntimeStores` (`SPEC.md` §3.1 & §3.9).
 */
export interface ResolveFlowRuntimeStoresParams {
  /** Flow AST nodes to inspect. */
  readonly flows: readonly FlowNode<unknown, unknown>[];

  /** Composite executor registry. */
  readonly registry: RuntimeExecutorRegistry;

  /** Driver resolution context (`resolveEnv`, `getRunner`, `registry`). */
  readonly drvCtx: RuntimeDriverContext;

  /** Diagnostic context label (`"flow 'id'"` or `"harness 'id'"`). */
  readonly contextLabel: string;

  /** Optional additional human nodes (such as lane budget approvers or harness signal notifications). */
  readonly extraHumans?: ReadonlyArray<
    HumanNode<'bidirectional'> | HumanNode<'notify-only'> | HumanNode
  >;
}

/**
 * Recursively collects `TopologyNode`, `LessonsNode`, and `HumanNode` declarations from a `StepASTNode` and its nested capabilities or interrupt handlers.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {StepASTNode<unknown, unknown, THandle>} step      - Step executable to traverse.
 * @param {Set<string>}                            visited   - Set of already-visited step IDs to guard against cycles.
 * @param {{ topologyNode: TopologyNode<string> | undefined; lessonsNode: LessonsNode | undefined; humansById: Map<string, HumanNode<'bidirectional' | 'notify-only'>> }} collected - Mutable accumulator of discovered AST nodes.
 */
function collectStepStoreNodes<THandle = unknown>(
  step: StepASTNode<unknown, unknown, THandle>,
  visited: Set<string>,
  collected: {
    topologyNode: TopologyNode<string> | undefined;
    lessonsNode: LessonsNode | undefined;
    readonly humansById: Map<
      string,
      HumanNode<'bidirectional'> | HumanNode<'notify-only'> | HumanNode
    >;
  },
): void {
  const visitHandlers = (
    handlers: readonly InterruptHandlerNode<unknown, unknown, THandle>[],
  ): void => {
    for (const handler of handlers) {
      if (handler.mode === 'ask') {
        collected.humansById.set(handler.human.id, handler.human);
      } else if (handler.mode === 'adjudicate') {
        collectStepStoreNodes(handler.adjudicator, visited, collected);
        visitHandlers(handler.onInterruptHandlers);
      } else if (handler.mode === 'replace') {
        collectStepStoreNodes(handler.replacementExecutable, visited, collected);
      }
    }
  };
  if (step.type === 'harness:agent') {
    if (visited.has(`agent:${step.id}:${step.roleKey}`)) {
      return;
    }
    visited.add(`agent:${step.id}:${step.roleKey}`);
    if (collected.topologyNode === undefined && step.topology !== undefined) {
      collected.topologyNode = step.topology;
    }
    if (collected.lessonsNode === undefined && step.lessons !== undefined) {
      collected.lessonsNode = step.lessons.node;
    }
    if (
      collected.topologyNode === undefined &&
      step.capabilities?.mutatePlan?.topologyToUpdate !== undefined
    ) {
      collected.topologyNode = step.capabilities.mutatePlan.topologyToUpdate;
    }
    for (const esc of step.capabilities?.escalations ?? []) {
      collected.humansById.set(esc.human.id, esc.human);
    }
    for (const fCap of step.capabilities?.forks ?? []) {
      collectStepStoreNodes(fCap.childExecutable, visited, collected);
    }
    for (const sCap of step.capabilities?.speculations ?? []) {
      collectStepStoreNodes(sCap.workerExecutable, visited, collected);
      collectStepStoreNodes(sCap.arbiter.actor, visited, collected);
      if (sCap.verifyWinnerWith !== undefined) {
        collectStepStoreNodes(sCap.verifyWinnerWith.evaluator, visited, collected);
      }
      if (sCap.refineWinnerWhen !== undefined) {
        collectStepStoreNodes(sCap.refineWinnerWhen.refinementExecutable, visited, collected);
      }
    }
    visitHandlers(step.onInterruptHandlers);
  } else if (step.type === 'harness:loop') {
    if (visited.has(`loop:${step.id}`)) {
      return;
    }
    visited.add(`loop:${step.id}`);
    if (collected.lessonsNode === undefined && step.distillLessons !== undefined) {
      collected.lessonsNode = step.distillLessons;
    }
    collectStepStoreNodes(step.actStep.actor, visited, collected);
    collectStepStoreNodes(step.evaluateStep.evaluator, visited, collected);
  }
}

/**
 * Traverses one or more `FlowNode` AST trees (and optional extra `HumanNode` declarations) and instantiates their `TopologyStore`, `LessonStore`, and `HumanAdapter` instances via `registry` (`SPEC.md` §3.1 & §3.9).
 *
 * Throws actionable fail-closed errors (`Rule 5.4`) when a referenced store or human channel factory is missing from `registry`.
 *
 * @param {ResolveFlowRuntimeStoresParams} params - Flows, registry, driver context, diagnostic label, and optional extra humans.
 *
 * @returns {{ readonly topologyNode: TopologyNode<string> | undefined; readonly topologyStore: TopologyStore | undefined; readonly lessonsNode: LessonsNode | undefined; readonly lessonStore: LessonStore | undefined; readonly humanAdaptersById: Map<string, HumanAdapter> }} Instantiated stores and human adapters.
 */
export function resolveFlowRuntimeStores(params: ResolveFlowRuntimeStoresParams): {
  readonly topologyNode: TopologyNode<string> | undefined;
  readonly topologyStore: TopologyStore | undefined;
  readonly lessonsNode: LessonsNode | undefined;
  readonly lessonStore: LessonStore | undefined;
  readonly humanAdaptersById: Map<string, HumanAdapter>;
} {
  const { flows, registry, drvCtx, contextLabel, extraHumans = [] } = params;
  const visited = new Set<string>();
  const collected: {
    topologyNode: TopologyNode<string> | undefined;
    lessonsNode: LessonsNode | undefined;
    readonly humansById: Map<
      string,
      HumanNode<'bidirectional'> | HumanNode<'notify-only'> | HumanNode
    >;
  } = {
    topologyNode: undefined,
    lessonsNode: undefined,
    humansById: new Map<
      string,
      HumanNode<'bidirectional'> | HumanNode<'notify-only'> | HumanNode
    >(),
  };
  for (const h of extraHumans) {
    collected.humansById.set(h.id, h);
  }
  const visitFlowNodes = (
    items: ReadonlyArray<
      FlowStepNode<unknown, unknown, unknown> | FlowBranchNode<unknown, unknown, unknown>
    >,
  ): void => {
    for (const item of items) {
      if (item.type !== 'harness:flow-step') {
        for (const branchCase of item.cases) {
          visitFlowNodes(branchCase.steps);
        }
        visitFlowNodes(item.otherwiseSteps);
        continue;
      }
      collectStepStoreNodes(item.step, visited, collected);
      for (const h of item.onInterruptHandlers) {
        if (h.mode === 'ask') {
          collected.humansById.set(h.human.id, h.human);
        } else if (h.mode === 'adjudicate') {
          collectStepStoreNodes(h.adjudicator, visited, collected);
          for (const nested of h.onInterruptHandlers) {
            if (nested.mode === 'ask') {
              collected.humansById.set(nested.human.id, nested.human);
            }
          }
        } else if (h.mode === 'replace') {
          collectStepStoreNodes(h.replacementExecutable, visited, collected);
        }
      }
    }
  };
  for (const flow of flows) {
    visitFlowNodes(flow.nodes);
  }
  let topologyStore: TopologyStore | undefined;
  if (collected.topologyNode !== undefined) {
    const topoStoreType = collected.topologyNode.store
      .type as keyof RuntimeExecutorRegistry['topologies'];
    const topoFactory = registry.topologies[topoStoreType];
    if (topoFactory === undefined) {
      throw new Error(
        `No TopologyStore registered for '${collected.topologyNode.store.type}' (topology id '${collected.topologyNode.id}', ${contextLabel}).`,
      );
    }
    topologyStore = topoFactory(collected.topologyNode.store as never, drvCtx);
  }
  let lessonStore: LessonStore | undefined;
  if (collected.lessonsNode !== undefined) {
    const lessonFactory = registry.lessons[collected.lessonsNode.store.type];
    if (lessonFactory === undefined) {
      throw new Error(
        `No LessonStore registered for '${collected.lessonsNode.store.type}' (lessons id '${collected.lessonsNode.id}', ${contextLabel}).`,
      );
    }
    lessonStore = lessonFactory(collected.lessonsNode.store as never, drvCtx);
  }
  const humanAdaptersById = new Map<string, HumanAdapter>();
  for (const humanNode of collected.humansById.values()) {
    const chFactory = registry.humanChannels[humanNode.channel.type];
    if (chFactory === undefined) {
      throw new Error(
        `No HumanAdapter registered for '${humanNode.channel.type}' (human id '${humanNode.id}', ${contextLabel}).`,
      );
    }
    humanAdaptersById.set(humanNode.id, chFactory(humanNode.channel as never, drvCtx));
  }
  return {
    topologyNode: collected.topologyNode,
    topologyStore,
    lessonsNode: collected.lessonsNode,
    lessonStore,
    humanAdaptersById,
  };
}
