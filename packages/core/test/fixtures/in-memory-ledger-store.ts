import type { ContinuationFrame } from '../../src/ports/continuation-frame.types.js';
import type { CreateOrResumeRunInput } from '../../src/ports/create-or-resume-run-input.js';
import type { CreateOrResumeRunResult } from '../../src/ports/create-or-resume-run-result.js';
import type { InterruptedStepBootRecord } from '../../src/ports/interrupted-step-boot-record.js';
import type { LedgerStore } from '../../src/ports/ledger-store.js';
import type { MutateLanePlanRequest } from '../../src/ports/mutate-lane-plan-request.js';
import type { RecordStepStartInput } from '../../src/ports/record-step-start-input.js';
import type { RecordStepTransitionInput } from '../../src/ports/record-step-transition-input.js';
import type { RunTerminalReceiptRecord } from '../../src/ports/run-terminal-receipt-record.js';
import type { SuspendedForkRecord } from '../../src/ports/suspended-fork-record.js';
import type { WireFrameRecord } from '../../src/ports/wire-frame-record.js';

/**
 * Deterministic in-memory `LedgerStore` test fixture (`SPEC.md` §3.10).
 *
 * Implements run creation/resumption, continuation stack updates, wire frame chains, tombstones,
 * suspended fork epochs, lane plan DAG mutations, and crash-recovery boot queries.
 */
export class InMemoryLedgerStore implements LedgerStore {
  /** Stored run records keyed by `runId`. */
  readonly runs = new Map<string, { runId: string; laneId: string; itemKey: string; status: string; currentStepId: string | null; inputJson: string; rewindPendingToStepId?: string; compiledPrefixesJson?: Readonly<Record<string, string>>; costUsd: number; approvedMaxCostUsd?: number; completedStepOutputsJson: Map<string, string>; dependsOn: string[] }>();
  /** Stored step records keyed by `stepExecId`. */
  readonly steps = new Map<string, { stepExecId: string; runId: string; stepId: string; executableId?: string; status: string; baseScopeCheckpoint?: string; headScopeCheckpoint?: string; continuationStack: readonly ContinuationFrame[]; outputJson?: string; telemetryJson?: string }>();
  /** Stored message frames keyed by `messageId`. */
  readonly frames = new Map<string, WireFrameRecord>();
  /** Stored tombstones keyed by `"${messageId}:${callId}"`. */
  readonly tombstones = new Map<string, string>();
  /** Stored suspended fork records keyed by `suspendedForkId`. */
  readonly suspendedForks = new Map<string, SuspendedForkRecord>();
  /** Resolution status for suspended forks keyed by `suspendedForkId`. */
  readonly resolvedSuspendedForks = new Map<string, 'RESUMED' | 'ABORTED'>();
  /** Stored terminal receipts keyed by `itemKey`. */
  readonly terminalReceipts = new Map<string, RunTerminalReceiptRecord>();
  /** Recorded lane plan mutation requests in chronological order. */
  readonly planMutations: MutateLanePlanRequest[] = [];
  /** Compacted run IDs recorded by `compactRunFrames()`. */
  readonly compactedRunIds: string[] = [];

  /**
   * Creates or resumes a flow run record for `run.runId`.
   *
   * Pins `compiledPrefixesJson` on initial creation and returns the current persisted run state.
   *
   * @param {CreateOrResumeRunInput} run - Run initialization and wire prefix payload.
   *
   * @returns {Promise<CreateOrResumeRunResult>} Current persisted run state.
   */
  async createOrResumeRun(run: CreateOrResumeRunInput): Promise<CreateOrResumeRunResult> {
    let entry = this.runs.get(run.runId);
    if (entry === undefined) { entry = { runId: run.runId, laneId: run.laneId, itemKey: run.itemKey, status: 'RUNNING', currentStepId: null, inputJson: run.inputJson, compiledPrefixesJson: run.compiledPrefixesJson, costUsd: run.costUsd ?? 0, approvedMaxCostUsd: run.approvedMaxCostUsd, completedStepOutputsJson: new Map(), dependsOn: [] }; this.runs.set(run.runId, entry); }
    else { if (run.compiledPrefixesJson !== undefined && entry.compiledPrefixesJson === undefined) entry.compiledPrefixesJson = run.compiledPrefixesJson; if (run.approvedMaxCostUsd !== undefined) entry.approvedMaxCostUsd = run.approvedMaxCostUsd; if (run.costUsd !== undefined) entry.costUsd = run.costUsd; }
    return Object.freeze<CreateOrResumeRunResult>({ status: entry.status, currentStepId: entry.currentStepId, inputJson: entry.inputJson, rewindPendingToStepId: entry.rewindPendingToStepId, compiledPrefixesJson: entry.compiledPrefixesJson, costUsd: entry.costUsd, approvedMaxCostUsd: entry.approvedMaxCostUsd, completedStepOutputsJson: new Map(entry.completedStepOutputsJson) });
  }

  /**
   * Records the start of a flow step execution and initializes its continuation stack.
   *
   * Updates the owning run's `currentStepId` and stores `baseScopeCheckpoint`.
   *
   * @param {RecordStepStartInput} step - Step execution metadata and initial continuation stack.
   *
   * @returns {Promise<void>} Resolves once recorded.
   */
  async recordStepStart(step: RecordStepStartInput): Promise<void> {
    const existing = this.steps.get(step.stepExecId), run = this.runs.get(step.runId); if (run !== undefined) run.currentStepId = step.stepId;
    this.steps.set(step.stepExecId, { stepExecId: step.stepExecId, runId: step.runId, stepId: step.stepId, executableId: step.executableId, status: 'RUNNING', baseScopeCheckpoint: step.baseScopeCheckpoint ?? existing?.baseScopeCheckpoint, continuationStack: existing !== undefined && existing.continuationStack.length > 0 ? existing.continuationStack : step.continuationStack });
  }

  /**
   * Updates the serialized `ContinuationFrame[]` stack for `stepExecId`.
   *
   * Optionally updates `baseScopeCheckpoint` when provided in `opts`.
   *
   * @param {string}                                    runId             - Enclosing flow run identifier.
   * @param {string}                                    stepExecId        - Target step execution identifier.
   * @param {readonly ContinuationFrame[]}              continuationStack - Updated outer-to-inner continuation stack.
   * @param {{ readonly baseScopeCheckpoint?: string }} [opts]            - Optional updated base scope checkpoint.
   *
   * @returns {Promise<void>} Resolves once updated.
   */
  async updateContinuationStack(runId: string, stepExecId: string, continuationStack: readonly ContinuationFrame[], opts?: { readonly baseScopeCheckpoint?: string }): Promise<void> {
    const ex = this.steps.get(stepExecId); this.steps.set(stepExecId, { stepExecId, runId, stepId: ex?.stepId ?? 'step', executableId: ex?.executableId, status: ex?.status ?? 'RUNNING', baseScopeCheckpoint: opts?.baseScopeCheckpoint ?? ex?.baseScopeCheckpoint, headScopeCheckpoint: ex?.headScopeCheckpoint, continuationStack: Object.freeze([...continuationStack]) });
  }

  /**
   * Updates a run's serialized flow input payload and optional pending rewind target step ID.
   *
   * Persists both `inputJson` and `rewindPendingToStepId` on the in-memory run record.
   *
   * @param {string}                                                                         runId  - Target flow run identifier.
   * @param {{ readonly inputJson: string; readonly rewindPendingToStepId?: string | null }} update - Updated input JSON and rewind target.
   *
   * @returns {Promise<void>} Resolves once updated.
   */
  async updateRunInput(runId: string, update: { readonly inputJson: string; readonly rewindPendingToStepId?: string | null }): Promise<void> { const run = this.runs.get(runId); if (run !== undefined) { run.inputJson = update.inputJson; run.rewindPendingToStepId = update.rewindPendingToStepId ?? undefined; } }
  /**
   * Records a lane plan DAG mutation request.
   *
   * Appends `req` to `planMutations` for deterministic test assertions.
   *
   * @param {MutateLanePlanRequest} req - Lane plan mutation request.
   *
   * @returns {Promise<void>} Resolves once recorded.
   */
  async mutateLanePlan(req: MutateLanePlanRequest): Promise<void> { this.planMutations.push(req); }
  /**
   * Appends a `WireFrameRecord` to the in-memory message store.
   *
   * Indexes the frame by `frame.messageId`.
   *
   * @param {string}          _runId - Enclosing flow run identifier.
   * @param {WireFrameRecord} frame  - Immutable wire frame record.
   *
   * @returns {Promise<void>} Resolves once stored.
   */
  async appendMessageFrame(_runId: string, frame: WireFrameRecord): Promise<void> { this.frames.set(frame.messageId, frame); }
  /**
   * Replaces an existing `WireFrameRecord` in-place by `frame.messageId`.
   *
   * Preserves chain links while updating the stored frame.
   *
   * @param {string}          _runId - Enclosing flow run identifier.
   * @param {WireFrameRecord} frame  - Updated wire frame record.
   *
   * @returns {Promise<void>} Resolves once replaced.
   */
  async replaceMessageFrame(_runId: string, frame: WireFrameRecord): Promise<void> { this.frames.set(frame.messageId, frame); }
  /**
   * Records a compacted skill tombstone on an `activateSkill` message frame.
   *
   * Updates `compactedTombstones` on the stored `WireFrameRecord` if present.
   *
   * @param {string} _runId             - Enclosing flow run identifier.
   * @param {string} messageId          - Target `WireFrameRecord.messageId`.
   * @param {string} callId             - Tool call ID of the `activateSkill` invocation.
   * @param {string} compactedTombstone - Tombstone replacement string.
   *
   * @returns {Promise<void>} Resolves once recorded.
   */
  async markFrameTombstone(_runId: string, messageId: string, callId: string, compactedTombstone: string): Promise<void> {
    this.tombstones.set(`${messageId}:${callId}`, compactedTombstone); const frame = this.frames.get(messageId); if (frame !== undefined) this.frames.set(messageId, Object.freeze<WireFrameRecord>({ ...frame, compactedTombstones: Object.freeze({ ...(frame.compactedTombstones ?? {}), [callId]: compactedTombstone }) }));
  }
  /**
   * Reconstructs the root-to-leaf `WireFrameRecord[]` chain ending at `leafMessageId`.
   *
   * Walks `parentMessageId` pointers backward and reverses the collected list.
   *
   * @param {string} leafMessageId - Trailing message frame ID.
   *
   * @returns {Promise<readonly WireFrameRecord[]>} Ordered root-to-leaf wire frame chain.
   */
  async getMessageChain(leafMessageId: string): Promise<readonly WireFrameRecord[]> {
    const chain: WireFrameRecord[] = []; let cursor: string | null = leafMessageId; while (cursor !== null) { const f = this.frames.get(cursor); if (f === undefined) break; chain.unshift(f); cursor = f.parentMessageId; } return Object.freeze(chain);
  }
  /**
   * Persists a `SuspendedForkRecord` keyed by `record.suspendedForkId`.
   *
   * Stores the suspension epoch and nested continuation stack.
   *
   * @param {SuspendedForkRecord} record - Suspended fork snapshot.
   *
   * @returns {Promise<void>} Resolves once stored.
   */
  async recordForkSuspension(record: SuspendedForkRecord): Promise<void> { this.suspendedForks.set(record.suspendedForkId, record); }
  /**
   * Queries open (`'SUSPENDED'`) fork records for `runId`.
   *
   * Filters by `opts.forkIds` and `opts.parentStepExecId` when provided.
   *
   * @param {string}                                                                       runId  - Enclosing flow run identifier.
   * @param {{ readonly forkIds?: readonly string[]; readonly parentStepExecId?: string }} [opts] - Optional filter criteria.
   *
   * @returns {Promise<readonly SuspendedForkRecord[]>} Matching open suspended fork records.
   */
  async getSuspendedForks(runId: string, opts?: { readonly forkIds?: readonly string[]; readonly parentStepExecId?: string }): Promise<readonly SuspendedForkRecord[]> {
    const matches: SuspendedForkRecord[] = []; for (const rec of this.suspendedForks.values()) if (rec.runId === runId && !this.resolvedSuspendedForks.has(rec.suspendedForkId) && (opts?.forkIds === undefined || opts.forkIds.includes(rec.forkId) || opts.forkIds.includes(rec.suspendedForkId)) && (opts?.parentStepExecId === undefined || rec.parentStepExecId === opts.parentStepExecId)) matches.push(rec); return Object.freeze(matches);
  }
  /**
   * Marks a suspended fork epoch as `'RESUMED'` or `'ABORTED'`.
   *
   * Updates `status` in `resolvedSuspendedForks`.
   *
   * @param {string}                suspendedForkId - Monotonic `${forkId}#${suspensionEpoch}` identifier.
   * @param {'RESUMED' | 'ABORTED'} status          - Resolution status.
   *
   * @returns {Promise<void>} Resolves once updated.
   */
  async resolveSuspendedFork(suspendedForkId: string, status: 'RESUMED' | 'ABORTED'): Promise<void> { this.resolvedSuspendedForks.set(suspendedForkId, status); }

  /**
   * Records a step lifecycle transition and updates completed step outputs on the run record.
   *
   * Stores `headScopeCheckpoint`, `outputJson`, and `telemetryJson`.
   *
   * @param {RecordStepTransitionInput} transition - Step transition payload.
   *
   * @returns {Promise<void>} Resolves once recorded.
   */
  async recordStepTransition(transition: RecordStepTransitionInput): Promise<void> {
    const step = this.steps.get(transition.stepExecId); if (step === undefined) return;
    step.status = transition.status; step.telemetryJson = transition.telemetryJson; if (transition.baseScopeCheckpoint !== undefined) step.baseScopeCheckpoint = transition.baseScopeCheckpoint; if (transition.headScopeCheckpoint !== undefined) step.headScopeCheckpoint = transition.headScopeCheckpoint; if (transition.outputJson !== undefined) step.outputJson = transition.outputJson;
    const run = this.runs.get(step.runId); if (run !== undefined && transition.status === 'COMPLETED' && transition.outputJson !== undefined) run.completedStepOutputsJson.set(step.stepId, transition.outputJson); if (run !== undefined && transition.status === 'SUSPENDED') run.status = 'SUSPENDED';
  }

  /**
   * Persists the terminal exit state and final scope receipt for `runId` and `itemKey`.
   *
   * Stores the receipt in `terminalReceipts` keyed by `itemKey`.
   *
   * @param {string} runId              - Completed flow run identifier.
   * @param {string} itemKey            - Work item deduplication key.
   * @param {string} terminalState      - Terminal exit state string.
   * @param {string} [scopeReceiptJson] - Optional JSON-serialized final scope receipt.
   *
   * @returns {Promise<void>} Resolves once stored.
   */
  async recordRunTerminalReceipt(runId: string, itemKey: string, terminalState: string, scopeReceiptJson?: string): Promise<void> { this.terminalReceipts.set(itemKey, Object.freeze<RunTerminalReceiptRecord>({ runId, terminalState, scopeReceiptJson })); const run = this.runs.get(runId); if (run !== undefined) run.status = terminalState; }
  /**
   * Retrieves terminal run receipts keyed by `itemKey`.
   *
   * Returns a read-only map of matching receipts.
   *
   * @param {readonly string[]} itemKeys - Work item keys to look up.
   *
   * @returns {Promise<ReadonlyMap<string, RunTerminalReceiptRecord>>} Map of `itemKey` to terminal receipt record.
   */
  async getRunTerminalReceipts(itemKeys: readonly string[]): Promise<ReadonlyMap<string, RunTerminalReceiptRecord>> { const out = new Map<string, RunTerminalReceiptRecord>(); for (const k of itemKeys) { const r = this.terminalReceipts.get(k); if (r !== undefined) out.set(k, r); } return out; }
  /**
   * Queries all non-terminal runs on boot.
   *
   * Returns `InterruptedStepBootRecord` entries for non-terminal runs.
   *
   * @returns {Promise<readonly InterruptedStepBootRecord[]>} Non-terminal boot records.
   */
  async getInterruptedStepsOnBoot(): Promise<readonly InterruptedStepBootRecord[]> {
    const out: InterruptedStepBootRecord[] = []; for (const step of this.steps.values()) if (step.status === 'RUNNING' || step.status === 'SUSPENDED') { const run = this.runs.get(step.runId); out.push(Object.freeze<InterruptedStepBootRecord>({ runId: step.runId, laneId: run?.laneId ?? 'lane', itemKey: run?.itemKey ?? step.runId, inputJson: run?.inputJson ?? '{}', status: step.status as 'RUNNING' | 'SUSPENDED', dependsOn: Object.freeze([...(run?.dependsOn ?? [])]), stepExecId: step.stepExecId, stepId: step.stepId, executableId: step.executableId, baseScopeCheckpoint: step.baseScopeCheckpoint, headScopeCheckpoint: step.headScopeCheckpoint, continuationStack: step.continuationStack })); } return Object.freeze(out);
  }
  /**
   * Records `runId` as compacted in `compactedRunIds`.
   *
   * Used to verify `.compactWhen()` signal triggers.
   *
   * @param {string} runId - Terminal flow run identifier to compact.
   *
   * @returns {Promise<void>} Resolves once recorded.
   */
  async compactRunFrames(runId: string): Promise<void> { this.compactedRunIds.push(runId); }
}
