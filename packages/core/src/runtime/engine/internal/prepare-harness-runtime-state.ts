import type { AstBuilder } from '../../../ast/ast-builder.js';
import type { HarnessNode } from '../../../ast/harness-node.js';
import type { HumanNode } from '../../../ast/human-node.js';
import type { TopologyNode } from '../../../ast/topology-node.js';
import { createExecutorRegistry } from '../../../ports/create-executor-registry.js';
import type { HarnessRuntimeOptions } from '../../../ports/harness-runtime-options.js';
import type { HumanAdapter } from '../../../ports/human-adapter.js';
import type { LedgerStore } from '../../../ports/ledger-store.js';
import type { LessonStore } from '../../../ports/lesson-store.js';
import type { RunnerDriver } from '../../../ports/runner-driver.js';
import type { RuntimeDriverContext } from '../../../ports/runtime-driver-context.js';
import type { RuntimeExecutorRegistry } from '../../../ports/runtime-executor-registry.js';
import type { TopologyStore } from '../../../ports/topology-store.js';
import { resolveFlowRuntimeStores } from '../../flow/internal/resolve-flow-runtime-stores.js';
import { LaneScheduler } from '../../lane/lane-scheduler.js';
import { ScopeLockManager } from '../../locks/scope-lock-manager.js';
import { StepContinuationQueue } from '../../locks/step-continuation-queue.js';
import { PoolManager } from '../../pools/pool-manager.js';
import { ServiceSessionRegistry } from '../../services/service-session-registry.js';

/**
 * Resolved harness AST, stores, driver context, and lane schedulers assembled during `createRuntime` initialization (`SPEC.md` §3.1 & §3.10).
 */
export interface PreparedHarnessRuntimeStateParams {
  /** Unwrapped root harness AST node. */
  readonly node: HarnessNode;

  /** Composite runtime executor registry. */
  readonly registry: RuntimeExecutorRegistry;

  /** Driver resolution context (`resolveEnv`, `getRunner`, `registry`). */
  readonly drvCtx: RuntimeDriverContext;

  /** Instantiated ledger store driver. */
  readonly ledgerStore: LedgerStore;

  /** Resolved primary topology AST node, if any. */
  readonly topologyNode: TopologyNode<string> | undefined;

  /** Resolved topology store driver, if any. */
  readonly topologyStore: TopologyStore | undefined;

  /** Resolved lesson store driver, if any. */
  readonly lessonStore: LessonStore | undefined;

  /** Resolved human channel adapters keyed by `human.id`. */
  readonly humanAdaptersById: Map<string, HumanAdapter>;

  /** Shared service daemon session registry. */
  readonly serviceRegistry: ServiceSessionRegistry;

  /** Per-lane schedulers keyed by `lane.id`. */
  readonly laneSchedulers: Map<string, LaneScheduler<unknown>>;
}

/**
 * Validates that all harness-level ledger, stream source, control plane, and lane tracker AST nodes have registered factories in `registry` (`Rule 5.4`).
 *
 * @param {HarnessNode}             node     - Unwrapped root harness AST node.
 * @param {RuntimeExecutorRegistry} registry - Composite executor registry to validate against.
 *
 * @throws {Error} If any required ledger, stream source, control plane, or tracker factory is missing from `registry`.
 */
export function validateHarnessBootRegistrations(
  node: HarnessNode,
  registry: RuntimeExecutorRegistry,
): void {
  if (registry.ledgers[node.ledger.type] === undefined) {
    throw new Error(
      `No LedgerStore registered for '${node.ledger.type}' in harness '${node.id}' (registered ledgers: [${Object.keys(registry.ledgers).join(', ')}]).`,
    );
  }
  for (const sNode of node.streams) {
    if (registry.streamSources[sNode.source.type] === undefined) {
      throw new Error(
        `No StreamSource registered for '${sNode.source.type}' on stream '${sNode.id}' in harness '${node.id}' (registered streamSources: [${Object.keys(registry.streamSources).join(', ')}]).`,
      );
    }
  }
  for (const cpNode of node.exposedControlPlanes) {
    if (registry.controlPlanes[cpNode.type] === undefined) {
      throw new Error(
        `No ControlPlaneAdapter registered for '${cpNode.type}' in harness '${node.id}' (registered controlPlanes: [${Object.keys(registry.controlPlanes).join(', ')}]).`,
      );
    }
  }
  for (const lane of node.lanes) {
    if (lane.tracker !== undefined && registry.trackers[lane.tracker.adapter.type] === undefined) {
      throw new Error(
        `No TrackerAdapter registered for '${lane.tracker.adapter.type}' on lane '${lane.id}' (registered trackers: [${Object.keys(registry.trackers).join(', ')}]).`,
      );
    }
  }
}

/**
 * Unwraps the harness AST, validates boot registrations, resolves all stores and human adapters, and initializes per-lane `LaneScheduler` instances (`SPEC.md` §3.1 & §3.10).
 *
 * @param {HarnessNode | AstBuilder<HarnessNode>} harness   - Compiled `HarnessNode` or `P.harness(...)` builder.
 * @param {HarnessRuntimeOptions}                 [options] - Optional executor registry, environment map, and store overrides.
 *
 * @returns {PreparedHarnessRuntimeStateParams} Prepared harness runtime state.
 */
export function prepareHarnessRuntimeState(
  harness: HarnessNode | AstBuilder<HarnessNode>,
  options?: HarnessRuntimeOptions & {
    readonly topologyNode?: TopologyNode<string>;
    readonly topologyStore?: TopologyStore;
    readonly lessonStore?: LessonStore;
    readonly humanAdaptersById?: ReadonlyMap<string, HumanAdapter>;
  },
): PreparedHarnessRuntimeStateParams {
  const node: HarnessNode = 'toAST' in harness ? harness.toAST() : harness;
  const env = options?.env ?? {};
  const registry: RuntimeExecutorRegistry =
    options?.registry !== undefined
      ? createExecutorRegistry(options.registry)
      : createExecutorRegistry();
  validateHarnessBootRegistrations(node, registry);
  const memoizedRunners = new Map<string, RunnerDriver>();
  const drvCtx: RuntimeDriverContext = {
    registry,
    resolveEnv: (v) => (typeof v === 'string' ? v : env[v.key]),
    getRunner: (rNode) => {
      const existing = memoizedRunners.get(rNode.id);
      if (existing !== undefined) {
        return existing;
      }
      const factory = registry.runners[rNode.type];
      if (factory === undefined) {
        throw new Error(
          `No RunnerDriver registered for '${rNode.type}' (runner id '${rNode.id}', harness '${node.id}').`,
        );
      }
      const drv = factory(rNode as never);
      memoizedRunners.set(rNode.id, drv);
      return drv;
    },
  };
  const ledgerFactory = registry.ledgers[node.ledger.type];
  if (ledgerFactory === undefined) {
    throw new Error(`No LedgerStore registered for '${node.ledger.type}' in harness '${node.id}'.`);
  }
  const ledgerStore = ledgerFactory(node.ledger as never, drvCtx);
  const extraHumans: Array<
    HumanNode<'bidirectional'> | HumanNode<'notify-only'> | HumanNode
  > = [];
  for (const notif of node.onSignalNotifications) {
    extraHumans.push(notif.human);
  }
  for (const lane of node.lanes) {
    if (lane.maxCostUsd !== undefined) {
      extraHumans.push(lane.maxCostUsd.approver.human);
    }
  }
  const resolved = resolveFlowRuntimeStores({
    flows: node.lanes.map((l) => l.flow),
    registry,
    drvCtx,
    contextLabel: `harness '${node.id}'`,
    extraHumans,
    existingTopologyNode: options?.topologyNode,
    existingTopologyStore: options?.topologyStore,
    existingLessonStore: options?.lessonStore,
    existingHumanAdaptersById: options?.humanAdaptersById,
  });
  const lockManager = new ScopeLockManager();
  const continuationQueue = new StepContinuationQueue();
  const poolManager = new PoolManager();
  const serviceRegistry = new ServiceSessionRegistry();
  const laneSchedulers = new Map<string, LaneScheduler<unknown>>();
  for (const lane of node.lanes) {
    laneSchedulers.set(
      lane.id,
      new LaneScheduler({
        lane,
        registry,
        env,
        ledgerStore,
        topologyStore: resolved.topologyStore,
        topologyNode: resolved.topologyNode,
        lessonStore: resolved.lessonStore,
        lockManager,
        continuationQueue,
        poolManager,
        serviceRegistry,
        humanAdaptersById: resolved.humanAdaptersById,
      }),
    );
  }
  return {
    node,
    registry,
    drvCtx,
    ledgerStore,
    topologyNode: resolved.topologyNode,
    topologyStore: resolved.topologyStore,
    lessonStore: resolved.lessonStore,
    humanAdaptersById: resolved.humanAdaptersById,
    serviceRegistry,
    laneSchedulers,
  };
}
