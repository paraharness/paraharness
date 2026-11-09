import type { FlowNode } from '../../../ast/flow-node.js';
import type { HumanNode } from '../../../ast/human-node.js';
import type { LessonsNode } from '../../../ast/lessons-node.js';
import type { TopologyNode } from '../../../ast/topology-node.js';
import type { HumanAdapter } from '../../../ports/human-adapter.js';
import type { LessonStore } from '../../../ports/lesson-store.js';
import type { RuntimeDriverContext } from '../../../ports/runtime-driver-context.js';
import type { RuntimeExecutorRegistry } from '../../../ports/runtime-executor-registry.js';
import type { TopologyStore } from '../../../ports/topology-store.js';
import { collectFlowStoreAstNodes } from './collect-flow-store-ast-nodes.js';

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

  /** Optional pre-supplied topology AST node override. */
  readonly existingTopologyNode?: TopologyNode<string>;

  /** Optional pre-supplied topology store override. */
  readonly existingTopologyStore?: TopologyStore;

  /** Optional pre-supplied lesson store override. */
  readonly existingLessonStore?: LessonStore;

  /** Optional pre-supplied human adapter map override. */
  readonly existingHumanAdaptersById?: ReadonlyMap<string, HumanAdapter>;
}

/**
 * Validates all collected `TopologyNode` definitions against `params.registry.topologies` and returns the primary `TopologyStore` instance.
 *
 * @param {ResolveFlowRuntimeStoresParams}              params         - Store resolution parameters.
 * @param {ReadonlyMap<string, TopologyNode<string>>} topologiesById - Collected topology AST nodes keyed by ID.
 *
 * @returns {TopologyStore | undefined} Instantiated or pre-supplied primary topology store.
 */
function instantiateFlowTopologyStores(
  params: ResolveFlowRuntimeStoresParams,
  topologiesById: ReadonlyMap<string, TopologyNode<string>>,
): TopologyStore | undefined {
  if (params.existingTopologyStore !== undefined) {
    return params.existingTopologyStore;
  }
  let topologyStore: TopologyStore | undefined;
  for (const topoNode of topologiesById.values()) {
    const topoStoreType = topoNode.store.type as keyof RuntimeExecutorRegistry['topologies'];
    const topoFactory = params.registry.topologies[topoStoreType];
    if (topoFactory === undefined) {
      throw new Error(
        `No TopologyStore registered for '${topoNode.store.type}' (topology id '${topoNode.id}', ${params.contextLabel}).`,
      );
    }
    if (topologyStore === undefined) {
      topologyStore = topoFactory(topoNode.store as never, params.drvCtx);
    }
  }
  return topologyStore;
}

/**
 * Validates all collected `LessonsNode` definitions against `params.registry.lessons` and returns the primary `LessonStore` instance.
 *
 * @param {ResolveFlowRuntimeStoresParams}     params      - Store resolution parameters.
 * @param {ReadonlyMap<string, LessonsNode>} lessonsById - Collected lessons AST nodes keyed by ID.
 *
 * @returns {LessonStore | undefined} Instantiated or pre-supplied primary lesson store.
 */
function instantiateFlowLessonStores(
  params: ResolveFlowRuntimeStoresParams,
  lessonsById: ReadonlyMap<string, LessonsNode>,
): LessonStore | undefined {
  if (params.existingLessonStore !== undefined) {
    return params.existingLessonStore;
  }
  let lessonStore: LessonStore | undefined;
  for (const lNode of lessonsById.values()) {
    const lessonFactory = params.registry.lessons[lNode.store.type];
    if (lessonFactory === undefined) {
      throw new Error(
        `No LessonStore registered for '${lNode.store.type}' (lessons id '${lNode.id}', ${params.contextLabel}).`,
      );
    }
    if (lessonStore === undefined) {
      lessonStore = lessonFactory(lNode.store as never, params.drvCtx);
    }
  }
  return lessonStore;
}

/**
 * Traverses one or more `FlowNode` AST trees (and optional extra `HumanNode` declarations) and instantiates their `TopologyStore`, `LessonStore`, and `HumanAdapter` instances via `registry` (`SPEC.md` §3.1 & §3.9).
 *
 * Validates every declared `TopologyNode`, `LessonsNode`, and `HumanNode` across all steps, nested capabilities, and flow-step interrupt handlers, throwing actionable fail-closed errors (`Rule 5.4`) when a referenced store or human channel factory is missing from `registry`.
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
  const collected = collectFlowStoreAstNodes({
    flows: params.flows,
    extraHumans: params.extraHumans,
    existingTopologyNode: params.existingTopologyNode,
  });
  const topologyStore = instantiateFlowTopologyStores(params, collected.topologiesById);
  const lessonStore = instantiateFlowLessonStores(params, collected.lessonsById);
  const humanAdaptersById = new Map<string, HumanAdapter>(
    params.existingHumanAdaptersById?.entries() ?? [],
  );
  for (const humanNode of collected.humansById.values()) {
    if (humanAdaptersById.has(humanNode.id)) {
      continue;
    }
    const chFactory = params.registry.humanChannels[humanNode.channel.type];
    if (chFactory === undefined) {
      throw new Error(
        `No HumanAdapter registered for '${humanNode.channel.type}' (human id '${humanNode.id}', ${params.contextLabel}).`,
      );
    }
    humanAdaptersById.set(humanNode.id, chFactory(humanNode.channel as never, params.drvCtx));
  }
  return {
    topologyNode: collected.primaryTopologyNode,
    topologyStore,
    lessonsNode: collected.primaryLessonsNode,
    lessonStore,
    humanAdaptersById,
  };
}
