import type { AstBuilder } from '../../ast/ast-builder.js';
import type { HarnessNode } from '../../ast/harness-node.js';
import type { TopologyNode } from '../../ast/topology-node.js';
import type { ActiveRunSummary } from '../../ports/active-run-summary.js';
import type { ControlPlaneHandle } from '../../ports/control-plane-handle.js';
import { createExecutorRegistry } from '../../ports/create-executor-registry.js';
import type { HarnessRuntime } from '../../ports/harness-runtime.js';
import type { HarnessRuntimeController } from '../../ports/harness-runtime-controller.js';
import type { HarnessRuntimeOptions } from '../../ports/harness-runtime-options.js';
import type { HumanAdapter } from '../../ports/human-adapter.js';
import type { LessonStore } from '../../ports/lesson-store.js';
import type { RunnerDriver } from '../../ports/runner-driver.js';
import type { RuntimeDriverContext } from '../../ports/runtime-driver-context.js';
import type { RuntimeExecutorRegistry } from '../../ports/runtime-executor-registry.js';
import type { StreamSubscriptionHandle } from '../../ports/stream-subscription-handle.js';
import type { TopologyStore } from '../../ports/topology-store.js';
import { LaneScheduler } from '../lane/lane-scheduler.js';
import { ScopeLockManager } from '../locks/scope-lock-manager.js';
import { StepContinuationQueue } from '../locks/step-continuation-queue.js';
import { PoolManager } from '../pools/pool-manager.js';
import { ServiceSessionRegistry } from '../services/service-session-registry.js';
import { handleEmittedRuntimeSignal } from './internal/handle-emitted-runtime-signal.js';

/**
 * Instantiates a `HarnessRuntime` from a declarative `HarnessNode` AST (or `H.harness` builder) (`SPEC.md` §3.1 & §3.10).
 *
 * Binds the `RuntimeExecutorRegistry`, initializes per-lane `LaneScheduler` instances, subscribes
 * inbound `StreamSource` adapters, starts exposed `ControlPlaneAdapter` servers, and routes signals
 * across `.notify()`, `commitOverlayWhen`, `compactWhen`, and `.onSignal()` lane rewinds.
 *
 * @param {HarnessNode | AstBuilder<HarnessNode>} harness   - Compiled `HarnessNode` or `H.harness(...)` builder.
 * @param {HarnessRuntimeOptions}                 [options] - Optional executor registry, environment map, and runtime stores.
 *
 * @returns {HarnessRuntime} Lifecycle handle with `start()`, `stop()`, and `controller`.
 */
export function createRuntime(
  harness: HarnessNode | AstBuilder<HarnessNode>,
  options?: HarnessRuntimeOptions & { readonly topologyNode?: TopologyNode<string>; readonly topologyStore?: TopologyStore; readonly lessonStore?: LessonStore; readonly humanAdaptersById?: ReadonlyMap<string, HumanAdapter> },
): HarnessRuntime {
  const node: HarnessNode = 'toAST' in harness ? harness.toAST() : harness;
  const env = options?.env ?? {};
  const registry: RuntimeExecutorRegistry = options?.registry !== undefined ? createExecutorRegistry(options.registry) : createExecutorRegistry();
  const memoizedRunners = new Map<string, RunnerDriver>();
  const drvCtx: RuntimeDriverContext = {
    registry, resolveEnv: (v) => (typeof v === 'string' ? v : env[v.key]),
    getRunner: (rNode) => {
      const existing = memoizedRunners.get(rNode.id);
      if (existing !== undefined) return existing;
      const factory = registry.runners[rNode.type];
      if (factory === undefined) throw new Error(`No RunnerDriver registered for '${rNode.type}' (runner id '${rNode.id}', harness '${node.id}').`);
      const drv = factory(rNode as never);
      memoizedRunners.set(rNode.id, drv);
      return drv;
    },
  };
  const ledgerFactory = registry.ledgers[node.ledger.type];
  if (ledgerFactory === undefined) throw new Error(`No LedgerStore registered for '${node.ledger.type}' in harness '${node.id}'.`);
  const ledgerStore = ledgerFactory(node.ledger as never, drvCtx);
  const lockManager = new ScopeLockManager();
  const continuationQueue = new StepContinuationQueue();
  const poolManager = new PoolManager();
  const serviceRegistry = new ServiceSessionRegistry();
  const humanAdaptersById = new Map<string, HumanAdapter>(options?.humanAdaptersById?.entries() ?? []);
  for (const notif of node.onSignalNotifications) {
    const chFactory = registry.humanChannels[notif.human.channel.type];
    if (!humanAdaptersById.has(notif.human.id) && chFactory !== undefined) humanAdaptersById.set(notif.human.id, chFactory(notif.human.channel as never, drvCtx));
  }
  const laneSchedulers = new Map<string, LaneScheduler<unknown>>();
  for (const lane of node.lanes) laneSchedulers.set(lane.id, new LaneScheduler({ lane, registry, env, ledgerStore, topologyStore: options?.topologyStore, topologyNode: options?.topologyNode, lessonStore: options?.lessonStore, lockManager, continuationQueue, poolManager, serviceRegistry, humanAdaptersById }));
  const streamHandles: StreamSubscriptionHandle[] = [];
  const controlPlaneHandles: ControlPlaneHandle[] = [];
  const controller: HarnessRuntimeController = {
    async emitSignal<TPayload>(signalId: string, payload: TPayload): Promise<void> {
      await handleEmittedRuntimeSignal(signalId, payload, { node, ledgerStore, topologyNode: options?.topologyNode, topologyStore: options?.topologyStore, lessonStore: options?.lessonStore, humanAdaptersById, laneSchedulers });
    },
    async getActiveRuns(): Promise<ReadonlyArray<ActiveRunSummary>> {
      const summaries: ActiveRunSummary[] = [];
      for (const scheduler of laneSchedulers.values()) {
        for (const item of scheduler.getItemsByKey().values()) {
          if (item.status === 'QUEUED' || item.status === 'WAITING' || item.status === 'RUNNING' || item.status === 'SUSPENDED') summaries.push(Object.freeze<ActiveRunSummary>({ runId: item.runId, laneId: item.laneId, itemKey: item.itemKey, status: item.status }));
        }
      }
      return Object.freeze(summaries);
    },
  };
  return Object.freeze<HarnessRuntime>({
    controller,
    async start(): Promise<void> {
      try {
        await ledgerStore.getInterruptedStepsOnBoot();
        for (const sNode of node.streams) {
          const sFactory = registry.streamSources[sNode.source.type];
          if (sFactory !== undefined) streamHandles.push(await sFactory(sNode.source as never, drvCtx).subscribe(async (rawEvt: unknown) => {
            if (sNode.filterFn === undefined || sNode.filterFn(rawEvt)) await controller.emitSignal(sNode.signal.id, sNode.mapPayload(rawEvt));
          }));
        }
        for (const cpNode of node.exposedControlPlanes) {
          const cpFactory = registry.controlPlanes[cpNode.type];
          if (cpFactory !== undefined) controlPlaneHandles.push(await cpFactory(cpNode as never, drvCtx).start(controller));
        }
      } catch (err) {
        for (const cph of controlPlaneHandles.splice(0)) await cph.close();
        for (const sh of streamHandles.splice(0)) await sh.close();
        throw err;
      }
    },
    async stop(): Promise<void> {
      for (const sh of streamHandles.splice(0)) await sh.close();
      for (const cph of controlPlaneHandles.splice(0)) await cph.close();
    },
  });
}
