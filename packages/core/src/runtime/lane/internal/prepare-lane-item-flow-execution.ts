import type { IsolationScope } from '../../../ports/isolation-scope.js';
import type { LedgerStore } from '../../../ports/ledger-store.js';
import type { MutateLanePlanRequest } from '../../../ports/mutate-lane-plan-request.js';
import type { FlowExecutionContext } from '../../flow/flow-execution-context.js';
import { recoverInterruptedRunOnBoot } from '../../flow/internal/flow-replace-and-rewind.js';
import type { ScopeLockManager } from '../../locks/scope-lock-manager.js';
import type { StepContinuationQueue } from '../../locks/step-continuation-queue.js';
import { createMemoizedRunnerResolver } from '../../pools/internal/create-memoized-runner-resolver.js';
import type { PoolManager } from '../../pools/pool-manager.js';
import type { ServiceSessionRegistry } from '../../services/service-session-registry.js';
import type { LaneQueuedItemState } from '../lane-queued-item-state.js';
import type { LaneSchedulerConfig } from '../lane-scheduler-config.js';

/**
 * Shared runtime managers and item state map passed to `prepareLaneItemFlowExecution`.
 *
 * @template TIn Validated lane work item input type.
 */
export interface PrepareLaneItemFlowExecutionManagersParams<TIn = unknown> {
  /** Deduplicated map of tracked lane items keyed by `itemKey`. */
  readonly itemsByKey: ReadonlyMap<string, LaneQueuedItemState<TIn>>;

  /** Per-handle shared-read / exclusive-write lock manager. */
  readonly lockManager: ScopeLockManager;

  /** Per-step continuation stack update queue. */
  readonly continuationQueue: StepContinuationQueue;

  /** Capacity pool manager for models and seats. */
  readonly poolManager: PoolManager;

  /** Lifecycle registry for background daemon sessions. */
  readonly serviceRegistry: ServiceSessionRegistry;

  /** Whether the scheduled item is resuming from `'SUSPENDED'`. */
  readonly wasSuspended?: boolean;

  /** Optional callback invoked after `LedgerStore.mutateLanePlan` commits spawned items or added dependencies. */
  readonly onPlanMutated?: (req: MutateLanePlanRequest) => Promise<void>;
}

/**
 * Wraps `ledgerStore` so `mutateLanePlan` notifies the enclosing `LaneScheduler` when `onPlanMutated` is provided.
 *
 * @param {LedgerStore}                                           ledgerStore   - Underlying ledger store.
 * @param {((req: MutateLanePlanRequest) => Promise<void>) | undefined} onPlanMutated - Optional plan mutation hook.
 *
 * @returns {LedgerStore} Wrapped or original ledger store.
 */
function wrapLaneLedgerStore(
  ledgerStore: LedgerStore,
  onPlanMutated: ((req: MutateLanePlanRequest) => Promise<void>) | undefined,
): LedgerStore {
  if (onPlanMutated === undefined) {
    return ledgerStore;
  }
  return new Proxy(ledgerStore, {
    get(target: LedgerStore, prop: string | symbol, receiver: unknown): unknown {
      if (prop === 'mutateLanePlan') {
        return async (req: MutateLanePlanRequest): Promise<void> => {
          await target.mutateLanePlan(req);
          await onPlanMutated(req);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Acquires the root `IsolationScope`, syncs prerequisite receipts/overlays, and builds `FlowExecutionContext` for `item` (`SPEC.md` §3.7.2 & §3.10).
 *
 * Releases `scopeHandle` in `catch` if `syncRunOverlays` or `syncRoot` faults before returning (`Rule 5.3`).
 *
 * @template TIn Validated lane work item input type.
 *
 * @param {LaneSchedulerConfig<TIn>}                        cfg      - Lane scheduler configuration.
 * @param {LaneQueuedItemState<TIn>}                        item     - Scheduled lane item to run.
 * @param {PrepareLaneItemFlowExecutionManagersParams<TIn>} managers - Shared lock, continuation, pool, service, and item map state.
 *
 * @returns {Promise<{ readonly scopeDriver: IsolationScope<unknown>; readonly scopeHandle: unknown; readonly flowCtx: FlowExecutionContext<TIn, unknown> }>} Prepared scope handle and flow execution context.
 */
export async function prepareLaneItemFlowExecution<TIn = unknown>(
  cfg: LaneSchedulerConfig<TIn>,
  item: LaneQueuedItemState<TIn>,
  managers: PrepareLaneItemFlowExecutionManagersParams<TIn>,
): Promise<{
  readonly scopeDriver: IsolationScope<unknown>;
  readonly scopeHandle: unknown;
  readonly flowCtx: FlowExecutionContext<TIn, unknown>;
}> {
  const scopeFactory = cfg.registry.scopes[cfg.lane.flow.scope.type];
  if (scopeFactory === undefined) {
    throw new Error(
      `No IsolationScope registered for '${cfg.lane.flow.scope.type}' on lane '${cfg.lane.id}' (registered scopes: [${Object.keys(cfg.registry.scopes).join(', ')}]).`,
    );
  }
  const scopeDriver = scopeFactory(cfg.lane.flow.scope as never, {
    registry: cfg.registry,
    resolveEnv: (v) => (typeof v === 'string' ? v : cfg.env[v.key]),
    getRunner: createMemoizedRunnerResolver(cfg.registry, `lane '${cfg.lane.id}'`),
  }) as IsolationScope<unknown>;
  const pendingBootRecord =
    item.bootRecord ??
    (managers.wasSuspended === true
      ? (await cfg.ledgerStore.getInterruptedStepsOnBoot()).find((r) => r.runId === item.runId)
      : undefined);
  item.bootRecord = undefined;
  let scopeHandle: unknown =
    pendingBootRecord !== undefined ? undefined : await scopeDriver.acquireRoot(item.runId);
  const activeStepAbortController = new AbortController();
  try {
    if (pendingBootRecord === undefined) {
      const syncRootFn = (
        scopeDriver as {
          readonly syncRoot?: (
            h: unknown,
            r: readonly Record<string, unknown>[],
          ) => Promise<unknown>;
        }
      ).syncRoot;
      const depReceipts: Record<string, unknown>[] = [];
      for (const depKey of item.dependsOn) {
        const depItem = managers.itemsByKey.get(depKey);
        if (depItem?.scopeReceipt !== undefined) {
          depReceipts.push(depItem.scopeReceipt);
        }
        if (depItem !== undefined && cfg.topologyStore !== undefined) {
          await cfg.topologyStore.syncRunOverlays(item.runId, [depItem.runId]);
        }
      }
      if (depReceipts.length > 0 && syncRootFn !== undefined) {
        await managers.lockManager.withWriteLock(
          scopeHandle,
          () => syncRootFn.call(scopeDriver, scopeHandle, depReceipts),
          activeStepAbortController.signal,
        );
      }
    }
  } catch (err) {
    if (scopeHandle !== undefined) {
      await scopeDriver.release(scopeHandle);
    }
    throw err;
  }
  const flowCtx: FlowExecutionContext<TIn, unknown> = {
    runId: item.runId,
    laneId: item.laneId,
    itemKey: item.itemKey,
    flow: cfg.lane.flow,
    currentInput: item.input,
    scopeHandle,
    scopeDriver: scopeDriver as never,
    registry: cfg.registry,
    env: cfg.env,
    ledgerStore: wrapLaneLedgerStore(cfg.ledgerStore, managers.onPlanMutated),
    topologyNode: cfg.topologyNode,
    topologyStore: cfg.topologyStore,
    lessonStore: cfg.lessonStore,
    lockManager: managers.lockManager,
    continuationQueue: managers.continuationQueue,
    poolManager: managers.poolManager,
    serviceRegistry: managers.serviceRegistry,
    humanAdaptersById: cfg.humanAdaptersById ?? new Map(),
    prefixGroups: cfg.prefixGroups,
    wirePrefixesByGroupId: new Map(),
    completedStepOutputs: new Map(),
    stepBaseCheckpointsByStepId: new Map(),
    observedRunEffects: [],
    activeStepId: null,
    activeStepExecId: null,
    activeReplacementExecutable: undefined,
    resumeContinuationStack: undefined,
    activeStepAbortController,
    pendingRewindToStepId: undefined,
    retryConfig: cfg.lane.retry,
  };
  if (pendingBootRecord !== undefined) {
    await recoverInterruptedRunOnBoot({
      bootRecord: pendingBootRecord,
      flow: cfg.lane.flow,
      flowCtx,
    });
    scopeHandle = flowCtx.scopeHandle;
  }
  return { scopeDriver, scopeHandle, flowCtx };
}
