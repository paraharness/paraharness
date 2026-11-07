import type { ContinuationFrame } from '../../../src/ports/continuation-frame.types.js';
import type { CreateOrResumeRunInput } from '../../../src/ports/create-or-resume-run-input.js';
import type { CreateOrResumeRunResult } from '../../../src/ports/create-or-resume-run-result.js';
import type { RecordStepStartInput } from '../../../src/ports/record-step-start-input.js';
import type { RecordStepTransitionInput } from '../../../src/ports/record-step-transition-input.js';
import type { WireFrameRecord } from '../../../src/ports/wire-frame-record.js';
import type { InMemoryLedgerStore } from '../in-memory-ledger-store.js';

/**
 * Creates or resumes a flow run record inside `store`.
 *
 * Pins `compiledPrefixesJson` on initial creation and returns the current persisted run state.
 *
 * @param {InMemoryLedgerStore}    store - Target in-memory ledger store.
 * @param {CreateOrResumeRunInput} run   - Run initialization and wire prefix payload.
 *
 * @returns {CreateOrResumeRunResult} Current persisted run state.
 */
export function applyCreateOrResumeRun(store: InMemoryLedgerStore, run: CreateOrResumeRunInput): CreateOrResumeRunResult {
  let entry = store.runs.get(run.runId);
  if (entry === undefined) {
    entry = {
      runId: run.runId,
      laneId: run.laneId,
      itemKey: run.itemKey,
      status: 'RUNNING',
      currentStepId: null,
      inputJson: run.inputJson,
      compiledPrefixesJson: run.compiledPrefixesJson,
      costUsd: run.costUsd ?? 0,
      approvedMaxCostUsd: run.approvedMaxCostUsd,
      completedStepOutputsJson: new Map(),
      dependsOn: [],
    };
    store.runs.set(run.runId, entry);
  } else {
    if (run.compiledPrefixesJson !== undefined && entry.compiledPrefixesJson === undefined) {
      entry.compiledPrefixesJson = run.compiledPrefixesJson;
    }
    if (run.approvedMaxCostUsd !== undefined) {
      entry.approvedMaxCostUsd = run.approvedMaxCostUsd;
    }
    if (run.costUsd !== undefined) {
      entry.costUsd = run.costUsd;
    }
  }
  return Object.freeze<CreateOrResumeRunResult>({
    status: entry.status,
    currentStepId: entry.currentStepId,
    inputJson: entry.inputJson,
    rewindPendingToStepId: entry.rewindPendingToStepId,
    compiledPrefixesJson: entry.compiledPrefixesJson,
    costUsd: entry.costUsd,
    approvedMaxCostUsd: entry.approvedMaxCostUsd,
    completedStepOutputsJson: new Map(entry.completedStepOutputsJson),
  });
}

/**
 * Records the start of a flow step execution or updates its continuation stack in `store`.
 *
 * Preserves existing non-empty `continuationStack` on `recordStepStart` and replaces it on `updateContinuationStack`.
 *
 * @param {InMemoryLedgerStore}                            store - Target in-memory ledger store.
 * @param {RecordStepStartInput & { replaceStack?: true }} step  - Step metadata and continuation stack.
 */
export function applyStepStartOrUpdate(
  store: InMemoryLedgerStore,
  step: {
    readonly runId: string;
    readonly stepExecId: string;
    readonly stepId?: string;
    readonly executableId?: string;
    readonly baseScopeCheckpoint?: string;
    readonly continuationStack: readonly ContinuationFrame[];
    readonly replaceStack?: boolean;
  },
): void {
  const existing = store.steps.get(step.stepExecId);
  const run = store.runs.get(step.runId);
  if (run !== undefined && step.stepId !== undefined && step.replaceStack !== true) {
    run.currentStepId = step.stepId;
  }
  const stack = step.replaceStack === true || existing === undefined || existing.continuationStack.length === 0
    ? Object.freeze([...step.continuationStack])
    : existing.continuationStack;
  store.steps.set(step.stepExecId, {
    stepExecId: step.stepExecId,
    runId: step.runId,
    stepId: step.stepId ?? existing?.stepId ?? 'step',
    executableId: step.executableId ?? existing?.executableId,
    status: existing?.status ?? 'RUNNING',
    baseScopeCheckpoint: step.baseScopeCheckpoint ?? existing?.baseScopeCheckpoint,
    headScopeCheckpoint: existing?.headScopeCheckpoint,
    continuationStack: stack,
  });
}

/**
 * Records a step lifecycle transition and updates completed step outputs on the run record in `store`.
 *
 * Stores `headScopeCheckpoint`, `outputJson`, and `telemetryJson`.
 *
 * @param {InMemoryLedgerStore}       store      - Target in-memory ledger store.
 * @param {RecordStepTransitionInput} transition - Step transition payload.
 */
export function applyStepTransition(store: InMemoryLedgerStore, transition: RecordStepTransitionInput): void {
  const step = store.steps.get(transition.stepExecId);
  if (step === undefined) {
    return;
  }
  step.status = transition.status;
  step.telemetryJson = transition.telemetryJson;
  if (transition.baseScopeCheckpoint !== undefined) {
    step.baseScopeCheckpoint = transition.baseScopeCheckpoint;
  }
  if (transition.headScopeCheckpoint !== undefined) {
    step.headScopeCheckpoint = transition.headScopeCheckpoint;
  }
  if (transition.outputJson !== undefined) {
    step.outputJson = transition.outputJson;
  }
  const run = store.runs.get(step.runId);
  if (run !== undefined && transition.status === 'COMPLETED' && transition.outputJson !== undefined) {
    run.completedStepOutputsJson.set(step.stepId, transition.outputJson);
  }
  if (run !== undefined && transition.status === 'SUSPENDED') {
    run.status = 'SUSPENDED';
  }
}

/**
 * Records a compacted skill tombstone on an `activateSkill` message frame in `store`.
 *
 * Updates `compactedTombstones` on the stored `WireFrameRecord` if present.
 *
 * @param {InMemoryLedgerStore} store     - Target in-memory ledger store.
 * @param {object}              tombstone - Target message ID, tool call ID, and tombstone replacement string.
 */
export function applyFrameTombstone(
  store: InMemoryLedgerStore,
  tombstone: {
    readonly messageId: string;
    readonly callId: string;
    readonly compactedTombstone: string;
  },
): void {
  const { messageId, callId, compactedTombstone } = tombstone;
  store.tombstones.set(`${messageId}:${callId}`, compactedTombstone);
  const frame = store.frames.get(messageId);
  if (frame !== undefined) {
    store.frames.set(
      messageId,
      Object.freeze<WireFrameRecord>({
        ...frame,
        compactedTombstones: Object.freeze({
          ...(frame.compactedTombstones ?? {}),
          [callId]: compactedTombstone,
        }),
      }),
    );
  }
}
