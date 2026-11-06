import type { IsolationScope } from '../../../ports/isolation-scope.js';
import type { TrackerAdapter } from '../../../ports/tracker-adapter.js';
import { BudgetApprovalSchema } from '../../../schemas/budget-and-lesson.schema.js';
import type { FlowExecutionContext } from '../../flow/flow-execution-context.js';
import { executeHierarchicalRewindDrain } from '../../flow/internal/flow-replace-and-rewind.js';
import type { ScopeLockManager } from '../../locks/scope-lock-manager.js';
import type { StepContinuationQueue } from '../../locks/step-continuation-queue.js';
import type { PoolManager } from '../../pools/pool-manager.js';
import type { ServiceSessionRegistry } from '../../services/service-session-registry.js';
import type { LaneQueuedItemState } from '../lane-queued-item-state.js';
import type { LaneSchedulerConfig } from '../lane-scheduler-config.js';

/**
 * Resolves the runtime `TrackerAdapter` for `cfg.lane.tracker` from `cfg.trackerAdapter` or `cfg.registry.trackers`.
 *
 * Returns `undefined` when no tracker is configured on the lane or registered in the executor registry.
 *
 * @template TIn Validated lane work item input type.
 *
 * @param {LaneSchedulerConfig<TIn>} cfg - Lane scheduler configuration and stores.
 *
 * @returns {TrackerAdapter<unknown, string> | undefined} Resolved tracker adapter, or `undefined`.
 */
export function resolveLaneTrackerAdapter<TIn = unknown>(
  cfg: LaneSchedulerConfig<TIn>,
): TrackerAdapter<unknown, string> | undefined {
  if (cfg.trackerAdapter !== undefined) return cfg.trackerAdapter;
  const node = cfg.lane.tracker?.adapter;
  const factory = node !== undefined ? cfg.registry.trackers[node.type] : undefined;
  if (factory === undefined || node === undefined) return undefined;
  return factory(node as never, {
    registry: cfg.registry,
    resolveEnv: (v) => (typeof v === 'string' ? v : cfg.env[v.key]),
    getRunner: (n) => {
      const f = cfg.registry.runners[n.type];
      if (f === undefined) throw new Error(n.type);
      return f(n as never);
    },
  });
}

/**
 * Acquires the root `IsolationScope`, syncs prerequisite receipts/overlays, and builds `FlowExecutionContext` for `item` (`SPEC.md` §3.7.2 & §3.10).
 *
 * Performs initial `syncRoot` and `syncRunOverlays` across `item.dependsOn` before flow execution starts.
 *
 * @template TIn Validated lane work item input type.
 *
 * @param {LaneSchedulerConfig<TIn>} cfg      - Lane scheduler configuration.
 * @param {LaneQueuedItemState<TIn>} item     - Scheduled lane item to run.
 * @param {object}                   managers - Shared lock, continuation, pool, service, and item map state.
 *
 * @returns {Promise<{ readonly scopeDriver: IsolationScope<unknown>; readonly scopeHandle: unknown; readonly flowCtx: FlowExecutionContext<TIn, unknown> }>} Prepared scope handle and flow execution context.
 */
export async function prepareLaneItemFlowExecution<TIn = unknown>(
  cfg: LaneSchedulerConfig<TIn>,
  item: LaneQueuedItemState<TIn>,
  managers: { readonly itemsByKey: ReadonlyMap<string, LaneQueuedItemState<TIn>>; readonly lockManager: ScopeLockManager; readonly continuationQueue: StepContinuationQueue; readonly poolManager: PoolManager; readonly serviceRegistry: ServiceSessionRegistry },
): Promise<{ readonly scopeDriver: IsolationScope<unknown>; readonly scopeHandle: unknown; readonly flowCtx: FlowExecutionContext<TIn, unknown> }> {
  const scopeFactory = cfg.registry.scopes[cfg.lane.flow.scope.type];
  if (scopeFactory === undefined) throw new Error(`No IsolationScope registered for '${cfg.lane.flow.scope.type}'.`);
  const scopeDriver = scopeFactory(cfg.lane.flow.scope as never, {
    registry: cfg.registry, resolveEnv: (v) => (typeof v === 'string' ? v : cfg.env[v.key]),
    getRunner: (n) => {
      const f = cfg.registry.runners[n.type];
      if (f === undefined) throw new Error(n.type);
      return f(n as never);
    },
  }) as IsolationScope<unknown>;
  const scopeHandle = await scopeDriver.acquireRoot(item.runId);
  const syncRootFn = (scopeDriver as { readonly syncRoot?: (h: unknown, r: readonly Record<string, unknown>[]) => Promise<unknown> }).syncRoot;
  const depReceipts: Record<string, unknown>[] = [];
  for (const depKey of item.dependsOn) {
    const depItem = managers.itemsByKey.get(depKey);
    if (depItem?.scopeReceipt !== undefined) depReceipts.push(depItem.scopeReceipt);
    if (depItem !== undefined && cfg.topologyStore !== undefined) await cfg.topologyStore.syncRunOverlays(item.runId, [depItem.runId]);
  }
  if (depReceipts.length > 0 && syncRootFn !== undefined) await syncRootFn.call(scopeDriver, scopeHandle, depReceipts);
  const flowCtx: FlowExecutionContext<TIn, unknown> = {
    runId: item.runId, laneId: item.laneId, itemKey: item.itemKey, flow: cfg.lane.flow, currentInput: item.input,
    scopeHandle, scopeDriver: scopeDriver as never, registry: cfg.registry, env: cfg.env, ledgerStore: cfg.ledgerStore,
    topologyStore: cfg.topologyStore, lessonStore: cfg.lessonStore, lockManager: managers.lockManager,
    continuationQueue: managers.continuationQueue, poolManager: managers.poolManager, serviceRegistry: managers.serviceRegistry,
    humanAdaptersById: cfg.humanAdaptersById ?? new Map(), prefixGroups: cfg.prefixGroups, wirePrefixesByGroupId: new Map(),
    completedStepOutputs: new Map(), observedRunEffects: [], activeStepId: null, activeStepExecId: null,
    activeStepAbortController: new AbortController(), retryConfig: cfg.lane.retry,
  };
  return { scopeDriver, scopeHandle, flowCtx };
}

/**
 * Evaluates and enforces `.maxCostUsd(limitUsd, approver)` for `item` (`SPEC.md` §3.10).
 *
 * Pages `approver` via `HumanAdapter.requestDecision` and either raises `approvedMaxCostUsd` (when `nextLimit > item.costUsd`) or cancels the run.
 *
 * @template TIn Validated lane work item input type.
 *
 * @param {LaneSchedulerConfig<TIn>}                          cfg          - Lane scheduler configuration.
 * @param {LaneQueuedItemState<TIn>}                          item         - Tracked lane item state.
 * @param {(itemKey: string, state: string) => Promise<void>} syncTracker  - Callback mirroring terminal `'cancelled'` state to `TrackerAdapter`.
 *
 * @returns {Promise<{ readonly allowed: boolean; readonly newLimitUsd?: number }>} Budget enforcement outcome.
 */
export async function evaluateLaneItemBudget<TIn = unknown>(
  cfg: LaneSchedulerConfig<TIn>,
  item: LaneQueuedItemState<TIn>,
  syncTracker: (itemKey: string, state: string) => Promise<void>,
): Promise<{ readonly allowed: boolean; readonly newLimitUsd?: number }> {
  const maxCfg = cfg.lane.maxCostUsd, currentLimit = item.approvedMaxCostUsd ?? maxCfg?.limitUsd;
  if (maxCfg === undefined || currentLimit === undefined || item.costUsd <= currentLimit) return Object.freeze({ allowed: true, newLimitUsd: currentLimit });
  const adapter = cfg.humanAdaptersById?.get(maxCfg.approver.human.id);
  if (adapter === undefined) throw new Error(`No HumanAdapter for budget approver '${maxCfg.approver.human.id}'.`);
  const decision = BudgetApprovalSchema.parse(await adapter.requestDecision({ requestId: `budget:${item.runId}:${String(item.costUsd)}`, runId: item.runId, humanId: maxCfg.approver.human.id, payload: { costUsd: item.costUsd, limitUsd: currentLimit }, responseSchema: BudgetApprovalSchema }));
  const nextLimit = decision.increaseLimitToUsd ?? currentLimit * 2;
  if (decision.approved && nextLimit > item.costUsd) {
    item.approvedMaxCostUsd = nextLimit;
    await cfg.ledgerStore.createOrResumeRun({ runId: item.runId, laneId: item.laneId, itemKey: item.itemKey, inputJson: JSON.stringify(item.input), costUsd: item.costUsd, approvedMaxCostUsd: nextLimit });
    return Object.freeze({ allowed: true, newLimitUsd: nextLimit });
  }
  item.status = 'CANCELLED';
  item.terminalExitState = 'cancelled';
  if (item.activeFlowCtx !== undefined) await executeHierarchicalRewindDrain({ flowCtx: item.activeFlowCtx, rewindToStepId: null, updatedInput: item.input, stepTerminalStatus: 'CANCELLED' });
  await cfg.ledgerStore.recordRunTerminalReceipt(item.runId, item.itemKey, 'cancelled');
  await syncTracker(item.itemKey, 'cancelled');
  return Object.freeze({ allowed: false });
}
