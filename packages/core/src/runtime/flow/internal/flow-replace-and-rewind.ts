import type { AgentContinuationFrame } from '../../../ports/agent-continuation-frame.js';
import type { BranchableScope } from '../../../ports/branchable-scope.js';
import type { ContinuationFrame } from '../../../ports/continuation-frame.types.js';
import type { ForkBatchContinuationFrame } from '../../../ports/fork-batch-continuation-frame.js';
import type { SpeculateContinuationFrame } from '../../../ports/speculate-continuation-frame.js';
import { syncSuspendedRunPrerequisites } from '../../plan/execute-plan-mutation.js';
import type {
  FlowExecutionContext,
  HierarchicalRewindDrainParams,
  RecoverInterruptedRunParams,
  ReplaceWithPromotionParams,
} from '../flow-execution-context.js';

/**
 * Promotes a `.replaceWith(replacementActor, mapInput)` handler by resetting step overlays and atomically recording replacement step start (`SPEC.md` §3.6 & §3.9).
 *
 * Discards aborted step lesson outcomes, updates persisted `run.inputJson` with `replacementInput`,
 * and sets `flowCtx.activeReplacementExecutable` so the flow step loop immediately executes the replacement.
 *
 * @template TIn     Validated flow input payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {ReplaceWithPromotionParams<TIn, THandle>} params - Promotion parameters and replacement executable.
 *
 * @returns {Promise<string>} Newly allocated `stepExecId` for the replacement executable.
 */
export async function executeReplaceWithPromotion<TIn = unknown, THandle = unknown>(
  params: ReplaceWithPromotionParams<TIn, THandle>,
): Promise<string> {
  const { flowCtx, stepExecId, stepId, baseScopeCheckpoint, replacementExecutable, replacementInput } = params;
  await flowCtx.serviceRegistry.quiesceScopeServices(stepExecId);
  if (flowCtx.topologyStore !== undefined) {
    await flowCtx.topologyStore.resetRunOverlay(flowCtx.runId, { scope: 'step', stepExecId });
  }
  await flowCtx.ledgerStore.recordStepTransition({
    stepExecId,
    status: 'INTERRUPTED',
    telemetryJson: JSON.stringify({ costUsd: 0, turnsTaken: 0, elapsedDurationMs: 0 }),
  });
  flowCtx.currentInput = replacementInput;
  await flowCtx.ledgerStore.updateRunInput(flowCtx.runId, { inputJson: JSON.stringify(replacementInput) });
  const replacementExecId = `${flowCtx.runId}:${stepId}:replace:${replacementExecutable.id}`;
  await flowCtx.ledgerStore.recordStepStart({
    runId: flowCtx.runId,
    stepExecId: replacementExecId,
    stepId,
    executableId: replacementExecutable.id,
    inputMsgId: null,
    baseScopeCheckpoint,
    continuationStack: Object.freeze([]),
  });
  flowCtx.activeStepExecId = replacementExecId;
  flowCtx.activeReplacementExecutable = replacementExecutable;
  return replacementExecId;
}

/**
 * Executes the 4-step Hierarchical Rewind Drain Barrier across active child forks, speculations, human requests, and run overlays (`SPEC.md` §3.10).
 *
 * If the run is currently `'SUSPENDED'`, records `rewindPendingToStepId` on the ledger without executing
 * `onRewindHook` until prerequisites complete (`SPEC.md` §3.7.2 & §3.10).
 *
 * @template TIn     Validated flow input payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {HierarchicalRewindDrainParams<TIn, THandle>} params - Rewind drain barrier parameters.
 *
 * @returns {Promise<{ readonly deferredWhileSuspended: boolean }>} Whether the rewind was deferred while `'SUSPENDED'`.
 */
export async function executeHierarchicalRewindDrain<TIn = unknown, THandle = unknown>(
  params: HierarchicalRewindDrainParams<TIn, THandle>,
): Promise<{ readonly deferredWhileSuspended: boolean }> {
  const { flowCtx, rewindToStepId, updatedInput, onRewindHook, stepTerminalStatus } = params;
  flowCtx.currentInput = updatedInput;
  const runState = await flowCtx.ledgerStore.createOrResumeRun({ runId: flowCtx.runId, laneId: flowCtx.laneId, itemKey: flowCtx.itemKey, inputJson: JSON.stringify(updatedInput) });
  if (runState.status === 'SUSPENDED' && rewindToStepId !== null) {
    await flowCtx.ledgerStore.updateRunInput(flowCtx.runId, { inputJson: JSON.stringify(updatedInput), rewindPendingToStepId: rewindToStepId });
    flowCtx.pendingRewindToStepId = rewindToStepId;
    return Object.freeze({ deferredWhileSuspended: true });
  }
  flowCtx.activeStepAbortController.abort(new Error(`Rewind drain barrier triggered for run '${flowCtx.runId}'.`));
  flowCtx.activeStepAbortController = new AbortController();
  for (const humanAdapter of flowCtx.humanAdaptersById.values()) await humanAdapter.cancelDecision?.(flowCtx.runId, flowCtx.activeStepExecId ?? flowCtx.runId);
  if (flowCtx.activeStepExecId !== null) {
    await flowCtx.serviceRegistry.quiesceScopeServices(flowCtx.activeStepExecId);
    await flowCtx.ledgerStore.recordStepTransition({ stepExecId: flowCtx.activeStepExecId, status: stepTerminalStatus === 'CANCELLED' ? 'FAILED' : 'INTERRUPTED', telemetryJson: JSON.stringify({ costUsd: 0, turnsTaken: 0, elapsedDurationMs: 0 }) });
  }
  if (flowCtx.topologyStore !== undefined) await flowCtx.topologyStore.resetRunOverlay(flowCtx.runId, { scope: 'run' });
  if (onRewindHook !== undefined) {
    const hookExec = flowCtx.registry.rewindHooks[onRewindHook.type];
    if (hookExec !== undefined) await hookExec(onRewindHook as never, { handle: flowCtx.scopeHandle } as never, undefined as never);
  }
  await flowCtx.ledgerStore.updateRunInput(flowCtx.runId, { inputJson: JSON.stringify(updatedInput), rewindPendingToStepId: rewindToStepId ?? undefined });
  if (rewindToStepId !== null) flowCtx.pendingRewindToStepId = rewindToStepId;
  return Object.freeze({ deferredWhileSuspended: false });
}

/**
 * Recovers a non-terminal run on boot by reattaching root and child isolation scopes and restoring in-flight checkpoints (`SPEC.md` §3.10).
 *
 * Restores `inFlightPreToolCheckpoint` when a crash occurred mid-subprocess, reattaches unfinished child
 * fork/speculate scopes via `reattachChild`, and syncs prerequisites for `'SUSPENDED'` runs.
 *
 * @template TIn     Validated flow input payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {RecoverInterruptedRunParams<TIn, THandle>} params - Crash recovery parameters and boot record.
 *
 * @returns {Promise<{ readonly reattachedChildHandles: ReadonlyMap<string, THandle>; readonly readyToResume: boolean }>} Reattached child handles and resume readiness.
 */
export async function recoverInterruptedRunOnBoot<TIn = unknown, THandle = unknown>(
  params: RecoverInterruptedRunParams<TIn, THandle>,
): Promise<{ readonly reattachedChildHandles: ReadonlyMap<string, THandle>; readonly readyToResume: boolean }> {
  const { bootRecord, flowCtx } = params;
  flowCtx.scopeHandle = await flowCtx.scopeDriver.reattachRoot(bootRecord.runId, bootRecord.baseScopeCheckpoint);
  const reattachedChildren = new Map<string, THandle>();
  const branchScope = flowCtx.scopeDriver as Partial<BranchableScope<THandle, Record<string, unknown>, Record<string, unknown>>>;
  for (const frame of bootRecord.continuationStack) {
    if (frame.kind === 'agent-frame' && frame.pauseState.kind === 'tool-batch' && frame.pauseState.inFlightPreToolCheckpoint !== undefined && flowCtx.scopeDriver.restoreCheckpoint !== undefined) {
      await flowCtx.scopeDriver.restoreCheckpoint(flowCtx.scopeHandle, frame.pauseState.inFlightPreToolCheckpoint);
    }
    if (frame.kind === 'fork-batch-frame' && branchScope.reattachChild !== undefined) {
      for (const fEntry of (frame as ForkBatchContinuationFrame).forks) {
        if (fEntry.status !== 'CHILD_COMMITTED' && fEntry.status !== 'ABORTED') reattachedChildren.set(fEntry.forkId, await branchScope.reattachChild(flowCtx.scopeHandle, fEntry.forkId));
      }
    }
    if (frame.kind === 'speculate-frame' && branchScope.reattachChild !== undefined) {
      for (const bEntry of (frame as SpeculateContinuationFrame).branches) {
        if (bEntry.status !== 'WINNER_COMMITTED' && bEntry.status !== 'FAILED') reattachedChildren.set(bEntry.forkId, await branchScope.reattachChild(flowCtx.scopeHandle, bEntry.forkId));
      }
    }
  }
  if (bootRecord.status === 'SUSPENDED' && bootRecord.stepExecId !== null) {
    const topAgent = bootRecord.continuationStack.find((f: ContinuationFrame): f is AgentContinuationFrame => f.kind === 'agent-frame');
    if (topAgent !== undefined) {
      const terminalReceipts = await flowCtx.ledgerStore.getRunTerminalReceipts(bootRecord.dependsOn);
      if (terminalReceipts.size < bootRecord.dependsOn.length) return Object.freeze({ reattachedChildHandles: reattachedChildren, readyToResume: false });
      await syncSuspendedRunPrerequisites({ runId: bootRecord.runId, stepExecId: bootRecord.stepExecId, headScopeCheckpoint: bootRecord.headScopeCheckpoint, prerequisiteItemKeys: bootRecord.dependsOn, prerequisiteRunIds: bootRecord.dependsOn.map((depKey: string) => terminalReceipts.get(depKey)?.runId ?? depKey), agentFrame: topAgent, outerFrames: bootRecord.continuationStack.filter((f: ContinuationFrame) => f !== topAgent), ledgerStore: flowCtx.ledgerStore, continuationQueue: flowCtx.continuationQueue, topologyStore: flowCtx.topologyStore, branchableScope: branchScope as never, serviceRegistry: flowCtx.serviceRegistry, scopeHandle: flowCtx.scopeHandle });
    }
  }
  return Object.freeze({ reattachedChildHandles: reattachedChildren, readyToResume: true });
}

/**
 * Folds observed run `ToolEffect[]` through `flow.telemetry` when configured (`SPEC.md` §3.9).
 *
 * Invokes the registered `TelemetryCollectorASTNode` executor in `flowCtx.registry.telemetryCollectors`
 * and returns the validated telemetry object.
 *
 * @template TIn     Validated flow input payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {FlowExecutionContext<TIn, THandle>} flowCtx - Active flow execution context.
 *
 * @returns {Promise<Readonly<Record<string, unknown>> | undefined>} Folded telemetry record, or `undefined`.
 */
export async function foldFlowCustomTelemetry<TIn = unknown, THandle = unknown>(
  flowCtx: FlowExecutionContext<TIn, THandle>,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  if (flowCtx.flow.telemetry === undefined) return undefined;
  const telNode = flowCtx.flow.telemetry;
  const telExec = flowCtx.registry.telemetryCollectors[telNode.type];
  if (telExec === undefined) return undefined;
  const rawMetrics = await telExec(telNode as never, flowCtx.observedRunEffects, undefined as never);
  return Object.freeze(rawMetrics);
}
