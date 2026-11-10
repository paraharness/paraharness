import type { AgentContinuationFrame } from '../../ports/agent-continuation-frame.js';
import type { CanonicalToolResult } from '../../ports/canonical-message.js';
import type { CheckpointableScope } from '../../ports/checkpointable-scope.js';
import type { ContinuationFrame } from '../../ports/continuation-frame.types.js';
import type { UniversalStepTelemetry } from '../../ports/universal-step-telemetry.js';
import type { WireFrameRecord } from '../../ports/wire-frame-record.js';
import { getStepRuntimeInternals } from '../agent/internal/get-step-runtime-internals.js';
import type { LimitExceededFlushParams } from './limit-exceeded-flush-params.js';
import type { LimitExceededFlushResult } from './limit-exceeded-flush-result.js';

/**
 * Persists `frame` onto the step's continuation stack via `continuationQueue` when available.
 *
 * Preserves any enclosing `outerFrames` ahead of `frame`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {LimitExceededFlushParams<THandle>} params - Flush parameters and ledger store.
 * @param {AgentContinuationFrame}            frame  - Updated agent continuation frame.
 *
 * @returns {Promise<void>} Resolves once persisted.
 */
async function persistLimitFlushContinuationFrame<THandle = unknown>(
  params: LimitExceededFlushParams<THandle>,
  frame: AgentContinuationFrame,
): Promise<void> {
  const stack: readonly ContinuationFrame[] = Object.freeze([
    ...(params.outerFrames ?? []),
    frame,
  ]);
  if (params.continuationQueue !== undefined) {
    await params.continuationQueue.enqueueUpdate(params.ctx.stepExecId, () =>
      params.ledgerStore.updateContinuationStack(params.ctx.runId, params.ctx.stepExecId, stack),
    );
    return;
  }
  await params.ledgerStore.updateContinuationStack(
    params.ctx.runId,
    params.ctx.stepExecId,
    stack,
  );
}

/**
 * Step 1 of `.onLimitExceeded()`: appends a complete `role: 'tool'` wire frame with `[Aborted: Limit Exceeded]` for unfinished `remainingCalls` (`SPEC.md` §3.5).
 *
 * Returns the updated `leafMessageId` after writing the trailing tool wire frame if a pending batch was active.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {LimitExceededFlushParams<THandle>} params - Flush parameters and pending tool batch.
 *
 * @returns {Promise<string | null>} Updated trailing `leafMessageId`.
 */
async function appendLimitAbortedTrailingToolFrame<THandle = unknown>(
  params: LimitExceededFlushParams<THandle>,
): Promise<string | null> {
  const batch = params.pendingToolBatch;
  if (
    batch === undefined ||
    (batch.completedResults.length === 0 && batch.remainingCalls.length === 0)
  ) {
    return params.agentFrame.leafMessageId;
  }
  const toolResults: CanonicalToolResult[] = [];
  for (const done of batch.completedResults) {
    toolResults.push({
      callId: done.callId,
      content: done.content,
      isError: done.isError === true,
    });
  }
  for (const rem of batch.remainingCalls) {
    toolResults.push({
      callId: rem.callId,
      content: '[Aborted: Limit Exceeded]',
      isError: true,
    });
  }
  const toolJson = JSON.stringify({ role: 'tool', toolResults });
  const toolFrameId = `msg:${params.ctx.stepExecId}:limit-abort-tools`;
  await params.ledgerStore.appendMessageFrame(
    params.ctx.runId,
    Object.freeze<WireFrameRecord>({
      messageId: toolFrameId,
      parentMessageId: params.agentFrame.leafMessageId,
      vendorId: params.modelDriver.vendorId,
      rawWireFrame: new TextEncoder().encode(toolJson),
      canonical: Object.freeze({
        role: 'tool',
        visibleText: '',
        toolResults: Object.freeze(toolResults),
      }),
      prefixDigest: params.wirePrefix?.systemDigest ?? 'unpinned',
    }),
  );
  return toolFrameId;
}

/**
 * Step 2 of `.onLimitExceeded()`: injects `[LIMIT_EXCEEDED_FLUSH]` and invokes one final `toolChoice: 'none'` epistemic flush turn (`SPEC.md` §3.5).
 *
 * Replays idempotently when `flushedInterruptPayloadJson` was already persisted prior to a crash.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {LimitExceededFlushParams<THandle>} params - Flush parameters and model driver.
 * @param {string | null}                     leafId - Trailing message frame ID after Step 1.
 *
 * @returns {Promise<{ readonly frame: AgentContinuationFrame; readonly leafId: string | null; readonly flushedPayload: unknown; readonly flushedPayloadJson: string }>} Flushed payload and updated continuation frame.
 */
async function runEpistemicFlushTurn<THandle = unknown>(
  params: LimitExceededFlushParams<THandle>,
  leafId: string | null,
): Promise<{
  readonly frame: AgentContinuationFrame;
  readonly leafId: string | null;
  readonly flushedPayload: unknown;
  readonly flushedPayloadJson: string;
}> {
  const { ctx, ledgerStore, limitConfig, modelDriver, modelNode } = params;
  const existingFlush =
    params.agentFrame.pauseState.kind === 'interrupt-flush'
      ? params.agentFrame.pauseState
      : undefined;
  let flushedPayloadJson = existingFlush?.flushedInterruptPayloadJson;
  let nextLeafId = leafId;
  let frameStep2: AgentContinuationFrame = Object.freeze({
    ...params.agentFrame,
    leafMessageId: nextLeafId,
    pausedAtPhase: 'LIMIT_EXCEEDED_FLUSH',
    pauseState: Object.freeze({
      kind: 'interrupt-flush',
      interruptId: limitConfig.flushInterrupt.id,
      flushPromptInjected: true,
      flushedInterruptPayloadJson: flushedPayloadJson,
      abortMetaJson: existingFlush?.abortMetaJson,
    }),
  });
  await persistLimitFlushContinuationFrame(params, frameStep2);
  if (flushedPayloadJson !== undefined) {
    const flushedPayload = limitConfig.flushInterrupt.schema.parse(
      JSON.parse(flushedPayloadJson),
    );
    return { frame: frameStep2, leafId: nextLeafId, flushedPayload, flushedPayloadJson };
  }
  const chain = nextLeafId !== null ? [...(await ledgerStore.getMessageChain(nextLeafId))] : [];
  const flushNote = `[LIMIT_EXCEEDED_FLUSH] ${params.tripReason}. Summarize state and emit final structured output.`;
  const lastFrame = chain[chain.length - 1];
  if (
    lastFrame !== undefined &&
    (lastFrame.canonical.role === 'tool' || lastFrame.canonical.role === 'user')
  ) {
    const updatedLast = await modelDriver.appendToolResultNotes(lastFrame, [flushNote]);
    await ledgerStore.replaceMessageFrame(ctx.runId, updatedLast);
    chain[chain.length - 1] = updatedLast;
  } else {
    const noteFrame = Object.freeze<WireFrameRecord>({
      messageId: `msg:${ctx.stepExecId}:flush-prompt`,
      parentMessageId: nextLeafId,
      vendorId: modelDriver.vendorId,
      rawWireFrame: new TextEncoder().encode(flushNote),
      canonical: Object.freeze({ role: 'user', visibleText: flushNote }),
      prefixDigest: params.wirePrefix?.systemDigest ?? 'unpinned',
    });
    await ledgerStore.appendMessageFrame(ctx.runId, noteFrame);
    chain.push(noteFrame);
    nextLeafId = noteFrame.messageId;
  }
  const startMs = Date.now();
  const resp = await modelDriver.invokeTurn({
    modelId: modelNode.modelId,
    effort: 'low',
    toolChoice: 'none',
    wirePrefix: params.wirePrefix,
    roleKey: params.agentFrame.roleKey,
    history: Object.freeze(chain),
    outputSchema: limitConfig.flushInterrupt.schema,
    signal: ctx.signal,
  });
  const latencyMs = Math.max(0, Date.now() - startMs);
  const flushedPayload = limitConfig.flushInterrupt.schema.parse(
    resp.structuredOutput ?? JSON.parse(resp.canonical.visibleText || '{}'),
  );
  flushedPayloadJson = JSON.stringify(flushedPayload);
  frameStep2 = Object.freeze({
    ...frameStep2,
    leafMessageId: nextLeafId,
    turnsTaken: frameStep2.turnsTaken + 1,
    costUsd: frameStep2.costUsd + resp.usage.costUsd,
    elapsedDurationMs: frameStep2.elapsedDurationMs + latencyMs,
    pauseState: Object.freeze({
      kind: 'interrupt-flush',
      interruptId: limitConfig.flushInterrupt.id,
      flushPromptInjected: true,
      flushedInterruptPayloadJson: flushedPayloadJson,
      abortMetaJson: existingFlush?.abortMetaJson,
    }),
  });
  await persistLimitFlushContinuationFrame(params, frameStep2);
  return { frame: frameStep2, leafId: nextLeafId, flushedPayload, flushedPayloadJson };
}

/**
 * Step 3 of `.onLimitExceeded()`: quiesces active `ServiceSession` daemons, executes `abortHook` (or restores `baseScopeCheckpoint`), and resets step-scoped topology overlay mutations (`SPEC.md` §3.5).
 *
 * Returns the abort metadata record returned by `abortHook` (or `{}` when checkpoint rollback is used).
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {LimitExceededFlushParams<THandle>} params - Flush parameters, service registry, and topology store.
 *
 * @returns {Promise<Record<string, unknown>>} Abort metadata object.
 */
async function quiesceAndExecuteAbortCleanup<THandle = unknown>(
  params: LimitExceededFlushParams<THandle>,
): Promise<Record<string, unknown>> {
  const { ctx, limitConfig } = params;
  await params.serviceRegistry?.quiesceScopeServices();
  let abortMeta: Record<string, unknown> = {};
  if (limitConfig.abortHook !== undefined) {
    const hookExec = ctx.registry.abortHooks[limitConfig.abortHook.type];
    if (hookExec === undefined) {
      throw new Error(`No AbortHook executor for '${limitConfig.abortHook.type}'.`);
    }
    abortMeta = await hookExec(
      limitConfig.abortHook as never,
      { handle: ctx.scopeHandle, runId: ctx.runId, stepExecId: ctx.stepExecId },
      ctx as never,
    );
  } else if (
    params.baseScopeCheckpoint !== undefined &&
    ctx.scope !== undefined &&
    'supportsCheckpoints' in ctx.scope
  ) {
    await (ctx.scope as CheckpointableScope<THandle, Record<string, unknown>>).restoreCheckpoint(
      ctx.scopeHandle,
      params.baseScopeCheckpoint,
    );
  }
  await params.topologyStore?.resetRunOverlay(ctx.runId, {
    scope: 'step',
    stepExecId: ctx.stepExecId,
  });
  return abortMeta;
}

/**
 * Executes the 4-step crash-safe `.onLimitExceeded()` epistemic flush and abort sequence (`SPEC.md` §3.5).
 *
 * 1. Synthesizes `[Aborted: Limit Exceeded]` results for unfinished `remainingCalls` and writes the `role: 'tool'` wire frame.
 * 2. Injects `[LIMIT_EXCEEDED_FLUSH]`, invokes 1 final `toolChoice: 'none'` turn with `effort: 'low'` and `flushInterrupt.schema`, and persists `flushedInterruptPayloadJson`.
 * 3. Quiesces all active `ServiceSession` daemons, runs `abortHook` (or restores `baseScopeCheckpoint`), and resets step-scoped topology overlay mutations.
 * 4. Atomically transitions the step to `'INTERRUPTED'` (discarding step lessons) and promotes any `.replaceWith()` executable.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {LimitExceededFlushParams<THandle>} params - Limit-exceeded flush parameters and stores.
 *
 * @returns {Promise<LimitExceededFlushResult>} Flushed interrupt payload, abort metadata, and updated frame.
 */
export async function executeLimitExceededSequence<THandle = unknown>(
  params: LimitExceededFlushParams<THandle>,
): Promise<LimitExceededFlushResult> {
  const { ctx, ledgerStore, limitConfig } = params;
  const step1LeafId = await appendLimitAbortedTrailingToolFrame(params);
  const step2 = await runEpistemicFlushTurn(params, step1LeafId);
  const abortMeta = await quiesceAndExecuteAbortCleanup(params);
  const frameStep3: AgentContinuationFrame = Object.freeze({
    ...step2.frame,
    accumulatedLessonOutcomes: undefined,
    bufferedGateRecoveries: undefined,
    pauseState: Object.freeze({
      kind: 'interrupt-flush',
      interruptId: limitConfig.flushInterrupt.id,
      flushPromptInjected: true,
      flushedInterruptPayloadJson: step2.flushedPayloadJson,
      abortMetaJson: JSON.stringify(abortMeta),
    }),
  });
  await persistLimitFlushContinuationFrame(params, frameStep3);
  if (params.replacementPromotion !== undefined) {
    const promo = params.replacementPromotion;
    const custom =
      (await getStepRuntimeInternals(ctx)?.collectCustomTelemetry?.()) ?? Object.freeze({});
    const stepTelemetry = Object.freeze<UniversalStepTelemetry>({
      turnsTaken: frameStep3.turnsTaken,
      costUsd: frameStep3.costUsd,
      durationMs: frameStep3.elapsedDurationMs,
      custom,
      abortMeta: limitConfig.abortHook !== undefined ? abortMeta : undefined,
    });
    const replacementInput = promo.mapReplacementInput(
      JSON.parse(params.agentFrame.inputJson || 'null'),
      step2.flushedPayload,
      abortMeta,
    );
    await ledgerStore.recordStepTransition({
      stepExecId: ctx.stepExecId,
      status: 'INTERRUPTED',
      telemetryJson: JSON.stringify(stepTelemetry),
    });
    await ledgerStore.updateRunInput(ctx.runId, {
      inputJson: JSON.stringify(replacementInput),
    });
    await ledgerStore.recordStepStart({
      runId: ctx.runId,
      stepExecId: promo.replacementStepExecId,
      stepId: promo.stepId,
      executableId: promo.replacementExecutableId,
      inputMsgId: step2.leafId,
      baseScopeCheckpoint: promo.baseScopeCheckpoint,
      continuationStack: promo.replacementInitialStack ?? Object.freeze([]),
    });
  }
  return Object.freeze<LimitExceededFlushResult>({
    interruptId: limitConfig.flushInterrupt.id,
    flushedPayload: step2.flushedPayload,
    abortMeta,
    leafMessageId: step2.leafId,
    updatedAgentFrame: frameStep3,
  });
}
