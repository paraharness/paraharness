import type { IsolationScope } from '../../ports/isolation-scope.js';
import type { TrackerAdapter } from '../../ports/tracker-adapter.js';
import { BudgetApprovalSchema } from '../../schemas/budget-and-lesson.schema.js';
import { executeFlow } from '../flow/execute-flow.js';
import type { FlowExecutionContext, FlowRunResult } from '../flow/flow-execution-context.js';
import { executeHierarchicalRewindDrain } from '../flow/internal/flow-replace-and-rewind.js';
import { ScopeLockManager } from '../locks/scope-lock-manager.js';
import { StepContinuationQueue } from '../locks/step-continuation-queue.js';
import { PoolManager } from '../pools/pool-manager.js';
import { ServiceSessionRegistry } from '../services/service-session-registry.js';
import { DEFAULT_PRIORITY_AGING_INTERVAL_MS, LANE_PRIORITY_WEIGHTS, PRIORITY_AGING_STEP_WEIGHT } from './lane-priority.constants.js';
import type { EnqueueLaneItemOptions, LaneQueuedItemState, LaneSchedulerConfig } from './lane-queued-item-state.js';

/**
 * Stateful lane scheduler managing deduplication, priority aging, `.waitFor()` DAG barriers, `.maxCostUsd()` budgets, tracker sync, and `.onSignal()` rewinds (`SPEC.md` §3.10).
 *
 * Enforces `lane.concurrency` across active `'RUNNING'` items while allowing `'SUSPENDED'` items to yield their slot.
 *
 * @template TIn Validated lane work item input type.
 */
export class LaneScheduler<TIn = unknown> {
  /** Injected lane configuration and runtime stores. */
  private readonly cfg: LaneSchedulerConfig<TIn>;
  /** Deduplicated work items keyed by `itemKey`. */
  private readonly itemsByKey = new Map<string, LaneQueuedItemState<TIn>>();
  /** Deduplicated work items keyed by `runId`. */
  private readonly itemsByRunId = new Map<string, LaneQueuedItemState<TIn>>();
  /** Shared lock manager. */
  private readonly lockManager: ScopeLockManager;
  /** Shared continuation queue. */
  private readonly continuationQueue: StepContinuationQueue;
  /** Shared pool manager. */
  private readonly poolManager: PoolManager;
  /** Shared service session registry. */
  private readonly serviceRegistry: ServiceSessionRegistry;

  /**
   * Creates a new `LaneScheduler` bound to `config.lane`.
   *
   * Initializes shared lock, continuation, pool, and service managers when not explicitly injected.
   *
   * @param {LaneSchedulerConfig<TIn>} config - Lane scheduler configuration and stores.
   */
  constructor(config: LaneSchedulerConfig<TIn>) {
    this.cfg = config; this.lockManager = config.lockManager ?? new ScopeLockManager(); this.continuationQueue = config.continuationQueue ?? new StepContinuationQueue(); this.poolManager = config.poolManager ?? new PoolManager(); this.serviceRegistry = config.serviceRegistry ?? new ServiceSessionRegistry();
  }

  /**
   * Computes the effective numeric scheduling priority for `item` at `nowMs` (`SPEC.md` §3.10).
   *
   * Combines `LANE_PRIORITY_WEIGHTS[lane.priority]`, `item.priorityBoost`, and aging steps.
   *
   * @param {LaneQueuedItemState<TIn>} item               - Queued item state to score.
   * @param {number}                   [nowMs=Date.now()] - Current epoch timestamp in milliseconds.
   *
   * @returns {number} Effective priority weight.
   */
  computeEffectivePriority(item: LaneQueuedItemState<TIn>, nowMs: number = Date.now()): number {
    const baseWeight = LANE_PRIORITY_WEIGHTS[this.cfg.lane.priority] ?? LANE_PRIORITY_WEIGHTS.normal, agingMinutes = this.cfg.lane.agingMinutes ?? 0;
    if (agingMinutes <= 0) return baseWeight + item.priorityBoost;
    return baseWeight + item.priorityBoost + Math.floor(Math.max(0, nowMs - item.enqueuedAtMs) / (agingMinutes * DEFAULT_PRIORITY_AGING_INTERVAL_MS)) * PRIORITY_AGING_STEP_WEIGHT;
  }

  /**
   * Mirrors an internal lifecycle state key (`'queued'`, `'running'`, `'waiting'`, `'errored'`, `'cancelled'`, or `'exit:<state>'`) to `TrackerAdapter` (`SPEC.md` §2.8 & §3.10).
   *
   * Looks up `canonicalKey` (and fallback `rawExit` for `'exit:<state>'`) in `lane.tracker.stateMappings`.
   *
   * @param {string} itemKey      - Work item key to update on the external tracker.
   * @param {string} canonicalKey - Canonical internal state key.
   * @param {string} [rawExit]    - Optional raw exit state fallback when `canonicalKey` starts with `'exit:'`.
   *
   * @returns {Promise<void>} Resolves once the external tracker state is updated.
   */
  async syncTrackerState(itemKey: string, canonicalKey: string, rawExit?: string): Promise<void> {
    const trackerCfg = this.cfg.lane.tracker;
    const mappedState = trackerCfg?.stateMappings[canonicalKey] ?? (rawExit !== undefined ? trackerCfg?.stateMappings[rawExit] : undefined);
    const adapter = mappedState !== undefined ? this.resolveTrackerAdapter() : undefined;
    if (adapter !== undefined && mappedState !== undefined) await adapter.setExternalState(itemKey, mappedState);
  }

  /**
   * Resolves the runtime `TrackerAdapter` for `lane.tracker` from `cfg.trackerAdapter` or `cfg.registry.trackers`.
   *
   * Returns `undefined` when no tracker is configured on the lane.
   *
   * @returns {TrackerAdapter<unknown, string> | undefined} Resolved tracker adapter, or `undefined`.
   */
  private resolveTrackerAdapter(): TrackerAdapter<unknown, string> | undefined {
    if (this.cfg.trackerAdapter !== undefined) return this.cfg.trackerAdapter;
    const node = this.cfg.lane.tracker?.adapter, factory = node !== undefined ? this.cfg.registry.trackers[node.type] : undefined;
    return factory !== undefined && node !== undefined ? factory(node as never, { registry: this.cfg.registry, resolveEnv: (v) => (typeof v === 'string' ? v : this.cfg.env[v.key]), getRunner: (n) => { const f = this.cfg.registry.runners[n.type]; if (f === undefined) throw new Error(n.type); return f(n as never); } }) : undefined;
  }

  /**
   * Polls `lane.tracker` once, filters raw issues through `fromIssue`, and enqueues non-`undefined` work items (`SPEC.md` §3.10).
   *
   * Skips external issues for which `fromIssue(issue)` returns `undefined` or whose `itemKey` is already tracked.
   *
   * @returns {Promise<readonly LaneQueuedItemState<TIn>[]>} Newly enqueued lane item states.
   */
  async pollTrackerOnce(): Promise<readonly LaneQueuedItemState<TIn>[]> {
    const trackerCfg = this.cfg.lane.tracker, adapter = this.resolveTrackerAdapter();
    if (trackerCfg === undefined || adapter === undefined) return Object.freeze([]);
    const rawIssues = await adapter.poll(), added: LaneQueuedItemState<TIn>[] = [];
    for (const raw of rawIssues) { const mapped = trackerCfg.fromIssue(raw); if (mapped !== undefined) added.push(await this.enqueueItem({ input: mapped })); }
    return Object.freeze(added);
  }

  /**
   * Enqueues or deduplicates a work item by `lane.keyMapper(input)` and persists its run record in `LedgerStore` (`SPEC.md` §3.10).
   *
   * Transitions the item to `'WAITING'` when prerequisite `dependsOn` keys are not yet `'COMPLETED'`, or `'QUEUED'` when ready.
   *
   * @param {EnqueueLaneItemOptions<TIn>} options - Work item input and optional scheduling overrides.
   *
   * @returns {Promise<LaneQueuedItemState<TIn>>} Enqueued or existing item state.
   */
  async enqueueItem(options: EnqueueLaneItemOptions<TIn>): Promise<LaneQueuedItemState<TIn>> {
    const validatedInput = this.cfg.lane.inputSchema.parse(options.input), itemKey = this.cfg.lane.keyMapper(validatedInput);
    const existing = this.itemsByKey.get(itemKey);
    if (existing !== undefined) return existing;
    const runId = options.runId ?? `run:${this.cfg.lane.id}:${itemKey}`, mappedDeps = this.cfg.lane.waitFor !== undefined ? this.cfg.lane.waitFor.depsMapper(validatedInput) : [];
    const dependsOn = Object.freeze([...new Set([...mappedDeps, ...(options.additionalDeps ?? [])])]);
    const initialStatus = dependsOn.some((depKey) => this.itemsByKey.get(depKey)?.status !== 'COMPLETED') ? 'WAITING' : 'QUEUED';
    const itemState: LaneQueuedItemState<TIn> = { runId, itemKey, laneId: this.cfg.lane.id, input: validatedInput, status: initialStatus, enqueuedAtMs: options.enqueuedAtMs ?? Date.now(), priorityBoost: options.priorityBoost ?? 0, dependsOn, costUsd: 0, approvedMaxCostUsd: this.cfg.lane.maxCostUsd?.limitUsd };
    this.itemsByKey.set(itemKey, itemState); this.itemsByRunId.set(runId, itemState);
    await this.cfg.ledgerStore.createOrResumeRun({ runId, laneId: this.cfg.lane.id, itemKey, inputJson: JSON.stringify(validatedInput), approvedMaxCostUsd: itemState.approvedMaxCostUsd });
    await this.syncTrackerState(itemKey, initialStatus === 'WAITING' ? 'waiting' : 'queued');
    return itemState;
  }

  /**
   * Evaluates `.waitFor()` prerequisite barriers and schedules ready `'QUEUED'` / `'SUSPENDED'` items up to `lane.concurrency` (`SPEC.md` §3.10).
   *
   * Transitions waiting items whose prerequisites failed/cancelled to `waitFor.onAbandonedState` and executes ready flows.
   *
   * @param {number} [nowMs=Date.now()] - Timestamp used for priority aging calculations.
   *
   * @returns {Promise<readonly FlowRunResult[]>} Flow run results for runs completed in this scheduling pass.
   */
  async scheduleNextReadyRuns(nowMs: number = Date.now()): Promise<readonly FlowRunResult[]> {
    for (const item of this.itemsByKey.values()) {
      if (item.status !== 'WAITING' && item.status !== 'QUEUED' && item.status !== 'SUSPENDED') continue;
      const abandonedDep = item.dependsOn.find((d) => { const st = this.itemsByKey.get(d)?.status; return st === 'FAILED' || st === 'CANCELLED' || st === 'ABANDONED'; });
      if (abandonedDep !== undefined && item.status !== 'SUSPENDED') { item.status = 'ABANDONED'; item.terminalExitState = this.cfg.lane.waitFor?.onAbandonedState ?? 'abandoned'; await this.syncTrackerState(item.itemKey, `exit:${item.terminalExitState}`, item.terminalExitState); continue; }
      const allDepsDone = item.dependsOn.every((d) => { const st = this.itemsByKey.get(d)?.status; return st === 'COMPLETED' || (item.status === 'SUSPENDED' && (st === 'FAILED' || st === 'CANCELLED')); });
      if (allDepsDone && item.status === 'WAITING') item.status = 'QUEUED';
    }
    const availableSlots = Math.max(0, this.cfg.lane.concurrency - [...this.itemsByKey.values()].filter((i) => i.status === 'RUNNING').length);
    const readyCandidates = [...this.itemsByKey.values()].filter((i) => (i.status === 'QUEUED' || i.status === 'SUSPENDED') && i.dependsOn.every((d) => { const st = this.itemsByKey.get(d)?.status; return st === 'COMPLETED' || (i.status === 'SUSPENDED' && (st === 'FAILED' || st === 'CANCELLED')); }));
    readyCandidates.sort((a, b) => this.computeEffectivePriority(b, nowMs) - this.computeEffectivePriority(a, nowMs));
    const results: FlowRunResult[] = [];
    for (const item of readyCandidates.slice(0, availableSlots)) results.push(await this.executeQueuedItemRun(item));
    return Object.freeze(results);
  }

  /**
   * Executes a single scheduled `LaneQueuedItemState` through `executeFlow()`, performing initial `syncRoot` on `QUEUED -> RUNNING` (`SPEC.md` §3.7.2 & §3.10).
   *
   * Updates `item.status` and mirrors terminal or suspended states to `TrackerAdapter`.
   *
   * @param {LaneQueuedItemState<TIn>} item - Scheduled item to run.
   *
   * @returns {Promise<FlowRunResult>} Flow run outcome.
   */
  private async executeQueuedItemRun(item: LaneQueuedItemState<TIn>): Promise<FlowRunResult> {
    item.status = 'RUNNING'; await this.syncTrackerState(item.itemKey, 'running');
    const scopeFactory = this.cfg.registry.scopes[this.cfg.lane.flow.scope.type];
    if (scopeFactory === undefined) throw new Error(`No IsolationScope registered for '${this.cfg.lane.flow.scope.type}'.`);
    const scopeDriver = scopeFactory(this.cfg.lane.flow.scope as never, { registry: this.cfg.registry, resolveEnv: (v) => (typeof v === 'string' ? v : this.cfg.env[v.key]), getRunner: (n) => { const f = this.cfg.registry.runners[n.type]; if (f === undefined) throw new Error(n.type); return f(n as never); } }) as IsolationScope<unknown>;
    const scopeHandle = await scopeDriver.acquireRoot(item.runId);
    const syncRootFn = (scopeDriver as { readonly syncRoot?: (h: unknown, r: readonly Record<string, unknown>[]) => Promise<unknown> }).syncRoot, depReceipts: Record<string, unknown>[] = [];
    for (const depKey of item.dependsOn) {
      const depItem = this.itemsByKey.get(depKey); if (depItem?.scopeReceipt !== undefined) depReceipts.push(depItem.scopeReceipt);
      if (depItem !== undefined && this.cfg.topologyStore !== undefined) await this.cfg.topologyStore.syncRunOverlays(item.runId, [depItem.runId]);
    }
    if (depReceipts.length > 0 && syncRootFn !== undefined) await syncRootFn.call(scopeDriver, scopeHandle, depReceipts);
    const flowCtx: FlowExecutionContext<TIn, unknown> = { runId: item.runId, laneId: item.laneId, itemKey: item.itemKey, flow: this.cfg.lane.flow, currentInput: item.input, scopeHandle, scopeDriver: scopeDriver as never, registry: this.cfg.registry, env: this.cfg.env, ledgerStore: this.cfg.ledgerStore, topologyStore: this.cfg.topologyStore, lessonStore: this.cfg.lessonStore, lockManager: this.lockManager, continuationQueue: this.continuationQueue, poolManager: this.poolManager, serviceRegistry: this.serviceRegistry, humanAdaptersById: this.cfg.humanAdaptersById ?? new Map(), prefixGroups: this.cfg.prefixGroups, wirePrefixesByGroupId: new Map(), completedStepOutputs: new Map(), observedRunEffects: [], activeStepId: null, activeStepExecId: null, activeStepAbortController: new AbortController(), retryConfig: this.cfg.lane.retry };
    item.activeFlowCtx = flowCtx;
    try {
      const res = await executeFlow(flowCtx); item.scopeReceipt = res.scopeReceipt;
      if (res.exitState === 'SUSPENDED') { item.status = 'SUSPENDED'; await this.syncTrackerState(item.itemKey, 'waiting'); return res; }
      item.status = 'COMPLETED'; item.terminalExitState = res.exitState; await this.cfg.ledgerStore.recordRunTerminalReceipt(item.runId, item.itemKey, res.exitState, JSON.stringify(res.scopeReceipt)); await this.syncTrackerState(item.itemKey, `exit:${res.exitState}`, res.exitState);
      return res;
    } catch (err) {
      if (this.cfg.lane.retry !== undefined) { item.status = 'FAILED'; item.terminalExitState = this.cfg.lane.retry.orFailState; await this.cfg.ledgerStore.recordRunTerminalReceipt(item.runId, item.itemKey, item.terminalExitState); await this.syncTrackerState(item.itemKey, 'errored'); await this.syncTrackerState(item.itemKey, `exit:${item.terminalExitState}`, item.terminalExitState); return Object.freeze<FlowRunResult>({ runId: item.runId, exitState: item.terminalExitState, scopeReceipt: {}, stepOutputs: Object.freeze({}) }); }
      item.status = 'FAILED'; await this.cfg.ledgerStore.recordRunTerminalReceipt(item.runId, item.itemKey, 'errored'); await this.syncTrackerState(item.itemKey, 'errored'); throw err;
    } finally { await scopeDriver.release(scopeHandle); item.activeFlowCtx = undefined; }
  }

  /**
   * Enforces the lane's `.maxCostUsd(limitUsd, approver)` ceiling on an active run (`SPEC.md` §3.10).
   *
   * Pages `approver` via `HumanAdapter.requestDecision`: raises limit on approval or cancels the run via Drain Barrier on denial.
   *
   * @param {string} runId        - Active run identifier.
   * @param {number} addedCostUsd - Additional USD cost incurred.
   *
   * @returns {Promise<{ readonly allowed: boolean; readonly newLimitUsd?: number }>} Budget enforcement outcome.
   */
  async enforceRunBudget(runId: string, addedCostUsd: number): Promise<{ readonly allowed: boolean; readonly newLimitUsd?: number }> {
    const item = this.itemsByRunId.get(runId);
    if (item === undefined) throw new Error(`Unknown run '${runId}' in lane '${this.cfg.lane.id}'.`);
    item.costUsd += addedCostUsd;
    const maxCfg = this.cfg.lane.maxCostUsd, currentLimit = item.approvedMaxCostUsd ?? maxCfg?.limitUsd;
    if (maxCfg === undefined || currentLimit === undefined || item.costUsd <= currentLimit) return Object.freeze({ allowed: true, newLimitUsd: currentLimit });
    const adapter = this.cfg.humanAdaptersById?.get(maxCfg.approver.human.id);
    if (adapter === undefined) throw new Error(`No HumanAdapter for budget approver '${maxCfg.approver.human.id}'.`);
    const decision = BudgetApprovalSchema.parse(await adapter.requestDecision({ requestId: `budget:${runId}:${String(item.costUsd)}`, runId, humanId: maxCfg.approver.human.id, payload: { costUsd: item.costUsd, limitUsd: currentLimit }, responseSchema: BudgetApprovalSchema }));
    if (decision.approved) { const nextLimit = decision.increaseLimitToUsd ?? currentLimit * 2; item.approvedMaxCostUsd = nextLimit; await this.cfg.ledgerStore.createOrResumeRun({ runId, laneId: item.laneId, itemKey: item.itemKey, inputJson: JSON.stringify(item.input), costUsd: item.costUsd, approvedMaxCostUsd: nextLimit }); return Object.freeze({ allowed: true, newLimitUsd: nextLimit }); }
    item.status = 'CANCELLED'; item.terminalExitState = 'cancelled';
    if (item.activeFlowCtx !== undefined) await executeHierarchicalRewindDrain({ flowCtx: item.activeFlowCtx, rewindToStepId: null, updatedInput: item.input, stepTerminalStatus: 'CANCELLED' });
    await this.syncTrackerState(item.itemKey, 'cancelled'); return Object.freeze({ allowed: false });
  }

  /**
   * Handles a live `.onSignal(signal, ...)` event correlated to an item in this lane (`SPEC.md` §3.10).
   *
   * Updates `item.input` via `handler.updateMapper` and executes `executeHierarchicalRewindDrain`.
   *
   * @template TPayload Signal payload type.
   *
   * @param {string}   signalId  - Emitted signal identifier.
   * @param {TPayload} payload   - Validated signal payload.
   * @param {string}   [itemKey] - Optional target `itemKey`.
   *
   * @returns {Promise<boolean>} True if a matching handler was triggered.
   */
  async handleSignalRewind<TPayload>(signalId: string, payload: TPayload, itemKey?: string): Promise<boolean> {
    const handler = this.cfg.lane.onSignalHandlers.find((h) => h.signal.id === signalId);
    if (handler === undefined) return false;
    const targets = itemKey !== undefined ? [this.itemsByKey.get(itemKey)].filter((x): x is LaneQueuedItemState<TIn> => x !== undefined) : [...this.itemsByKey.values()];
    for (const item of targets) {
      item.input = handler.updateMapper(item.input, payload);
      if (item.activeFlowCtx !== undefined) await executeHierarchicalRewindDrain({ flowCtx: item.activeFlowCtx, rewindToStepId: handler.rewindToStepId, updatedInput: item.input, onRewindHook: handler.onRewind });
      else await this.cfg.ledgerStore.updateRunInput(item.runId, { inputJson: JSON.stringify(item.input), rewindPendingToStepId: handler.rewindToStepId });
    }
    return targets.length > 0;
  }

  /**
   * Returns a snapshot of all tracked items in this lane.
   *
   * Used by `HarnessRuntimeController.getActiveRuns()` and test assertions.
   *
   * @returns {ReadonlyMap<string, LaneQueuedItemState<TIn>>} Map of `itemKey` to `LaneQueuedItemState`.
   */
  getItemsByKey(): ReadonlyMap<string, LaneQueuedItemState<TIn>> { return this.itemsByKey; }
}
