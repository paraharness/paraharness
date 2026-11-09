import type { HarnessNode } from '../../../ast/harness-node.js';
import type { ActiveRunSummary } from '../../../ports/active-run-summary.js';
import type { ControlPlaneHandle } from '../../../ports/control-plane-handle.js';
import type { HarnessRuntimeController } from '../../../ports/harness-runtime-controller.js';
import type { LedgerStore } from '../../../ports/ledger-store.js';
import type { RuntimeDriverContext } from '../../../ports/runtime-driver-context.js';
import type { RuntimeExecutorRegistry } from '../../../ports/runtime-executor-registry.js';
import type { StreamSubscriptionHandle } from '../../../ports/stream-subscription-handle.js';
import type { LaneScheduler } from '../../lane/lane-scheduler.js';
import type { ServiceSessionRegistry } from '../../services/service-session-registry.js';

/**
 * Parameters passed to `startHarnessSubscriptions` and `stopHarnessSubscriptions` (`SPEC.md` §3.1 & §3.10).
 */
export interface ManageHarnessRuntimeLifecycleParams {
  /** Unwrapped root harness AST node. */
  readonly node: HarnessNode;

  /** Composite runtime executor registry. */
  readonly registry: RuntimeExecutorRegistry;

  /** Driver resolution context. */
  readonly drvCtx: RuntimeDriverContext;

  /** Instantiated ledger store driver. */
  readonly ledgerStore: LedgerStore;

  /** Runtime controller exposed to streams and control planes. */
  readonly controller: HarnessRuntimeController;

  /** Shared service daemon session registry. */
  readonly serviceRegistry: ServiceSessionRegistry;

  /** Mutable list of active stream subscription handles. */
  readonly streamHandles: StreamSubscriptionHandle[];

  /** Mutable list of active control plane server handles. */
  readonly controlPlaneHandles: ControlPlaneHandle[];
}

/**
 * Appends active run summaries (`QUEUED`, `WAITING`, `RUNNING`, or `SUSPENDED`) from a single `LaneScheduler` into `summaries`.
 *
 * @param {LaneScheduler<unknown>} scheduler - Lane scheduler to inspect.
 * @param {ActiveRunSummary[]}     summaries - Output array of active run summaries.
 */
function appendSchedulerActiveRunSummaries(
  scheduler: LaneScheduler<unknown>,
  summaries: ActiveRunSummary[],
): void {
  for (const item of scheduler.getItemsByKey().values()) {
    if (
      item.status === 'QUEUED' ||
      item.status === 'WAITING' ||
      item.status === 'RUNNING' ||
      item.status === 'SUSPENDED'
    ) {
      summaries.push(
        Object.freeze<ActiveRunSummary>({
          runId: item.runId,
          laneId: item.laneId,
          itemKey: item.itemKey,
          status: item.status,
        }),
      );
    }
  }
}

/**
 * Collects frozen `ActiveRunSummary` records across all lane schedulers (`SPEC.md` §3.10).
 *
 * @param {ReadonlyMap<string, LaneScheduler<unknown>>} laneSchedulers - Active lane schedulers keyed by `lane.id`.
 *
 * @returns {ReadonlyArray<ActiveRunSummary>} Frozen list of active run summaries.
 */
export function collectActiveRunSummaries(
  laneSchedulers: ReadonlyMap<string, LaneScheduler<unknown>>,
): ReadonlyArray<ActiveRunSummary> {
  const summaries: ActiveRunSummary[] = [];
  for (const scheduler of laneSchedulers.values()) {
    appendSchedulerActiveRunSummaries(scheduler, summaries);
  }
  return Object.freeze(summaries);
}

/**
 * Starts all declared `StreamSource` subscriptions and exposed `ControlPlaneAdapter` servers, rolling back acquired handles on error (`Rule 5.3`).
 *
 * @param {ManageHarnessRuntimeLifecycleParams} params - Harness node, registry, stores, controller, and handle lists.
 *
 * @returns {Promise<void>} Resolves once all streams and control planes are active.
 */
export async function startHarnessSubscriptions(
  params: ManageHarnessRuntimeLifecycleParams,
): Promise<void> {
  const {
    node,
    registry,
    drvCtx,
    ledgerStore,
    controller,
    streamHandles,
    controlPlaneHandles,
  } = params;
  try {
    await ledgerStore.getInterruptedStepsOnBoot();
    for (const sNode of node.streams) {
      const sFactory = registry.streamSources[sNode.source.type];
      if (sFactory === undefined) {
        throw new Error(
          `No StreamSource registered for '${sNode.source.type}' on stream '${sNode.id}' in harness '${node.id}' (registered streamSources: [${Object.keys(registry.streamSources).join(', ')}]).`,
        );
      }
      streamHandles.push(
        await sFactory(sNode.source as never, drvCtx).subscribe(async (rawEvt: unknown) => {
          if (sNode.filterFn === undefined || sNode.filterFn(rawEvt)) {
            await controller.emitSignal(sNode.signal.id, sNode.mapPayload(rawEvt));
          }
        }),
      );
    }
    for (const cpNode of node.exposedControlPlanes) {
      const cpFactory = registry.controlPlanes[cpNode.type];
      if (cpFactory === undefined) {
        throw new Error(
          `No ControlPlaneAdapter registered for '${cpNode.type}' in harness '${node.id}' (registered controlPlanes: [${Object.keys(registry.controlPlanes).join(', ')}]).`,
        );
      }
      controlPlaneHandles.push(await cpFactory(cpNode as never, drvCtx).start(controller));
    }
  } catch (err) {
    await Promise.allSettled([
      ...controlPlaneHandles.splice(0).map((cph) => cph.close()),
      ...streamHandles.splice(0).map((sh) => sh.close()),
    ]);
    throw err;
  }
}

/**
 * Closes all active stream subscriptions and control-plane handles and quiesces background services (`Rule 5.3`).
 *
 * @param {ManageHarnessRuntimeLifecycleParams} params - Active stream handles, control plane handles, and service registry.
 *
 * @returns {Promise<void>} Resolves once all handles and services have closed cleanly.
 */
export async function stopHarnessSubscriptions(
  params: ManageHarnessRuntimeLifecycleParams,
): Promise<void> {
  const settled = await Promise.allSettled([
    ...params.streamHandles.splice(0).map((sh) => sh.close()),
    ...params.controlPlaneHandles.splice(0).map((cph) => cph.close()),
    params.serviceRegistry.quiesceScopeServices(),
  ]);
  for (const outcome of settled) {
    if (outcome.status === 'rejected') {
      throw outcome.reason;
    }
  }
}
