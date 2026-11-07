import type { AgentContinuationFrame } from '../../ports/agent-continuation-frame.js';
import type { CanonicalToolResult } from '../../ports/canonical-message.js';
import type { CheckpointableScope } from '../../ports/checkpointable-scope.js';
import type { ContinuationFrame } from '../../ports/continuation-frame.types.js';
import type { WireFrameRecord } from '../../ports/wire-frame-record.js';
import type { LimitExceededFlushParams } from './limit-exceeded-flush-params.js';
import type { LimitExceededFlushResult } from './limit-exceeded-flush-result.js';

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
  const { ctx, ledgerStore, limitConfig, modelDriver, modelNode } = params;
  const persistStack = async (frame: AgentContinuationFrame): Promise<void> => {
    const stack: readonly ContinuationFrame[] = Object.freeze([...(params.outerFrames ?? []), frame]);
    if (params.continuationQueue !== undefined) {
      await params.continuationQueue.enqueueUpdate(ctx.stepExecId, () => ledgerStore.updateContinuationStack(ctx.runId, ctx.stepExecId, stack));
    } else await ledgerStore.updateContinuationStack(ctx.runId, ctx.stepExecId, stack);
  };
  let leafId = params.agentFrame.leafMessageId;
  if (params.pendingToolBatch !== undefined && (params.pendingToolBatch.completedResults.length > 0 || params.pendingToolBatch.remainingCalls.length > 0)) {
    const toolResults: CanonicalToolResult[] = [];
    for (const done of params.pendingToolBatch.completedResults) toolResults.push({ callId: done.callId, content: done.content, isError: done.isError === true });
    for (const rem of params.pendingToolBatch.remainingCalls) toolResults.push({ callId: rem.callId, content: '[Aborted: Limit Exceeded]', isError: true });
    const toolJson = JSON.stringify({ role: 'tool', toolResults });
    const toolFrameId = `msg:${ctx.stepExecId}:limit-abort-tools`;
    await ledgerStore.appendMessageFrame(ctx.runId, Object.freeze<WireFrameRecord>({ messageId: toolFrameId, parentMessageId: leafId, vendorId: modelDriver.vendorId, rawWireFrame: new TextEncoder().encode(toolJson), canonical: Object.freeze({ role: 'tool', visibleText: '', toolResults: Object.freeze(toolResults) }), prefixDigest: params.wirePrefix?.systemDigest ?? 'unpinned' }));
    leafId = toolFrameId;
  }
  const existingFlush = params.agentFrame.pauseState.kind === 'interrupt-flush' ? params.agentFrame.pauseState : undefined;
  let flushedPayloadJson = existingFlush?.flushedInterruptPayloadJson;
  let frameStep2: AgentContinuationFrame = Object.freeze({ ...params.agentFrame, leafMessageId: leafId, pausedAtPhase: 'LIMIT_EXCEEDED_FLUSH', pauseState: Object.freeze({ kind: 'interrupt-flush', interruptId: limitConfig.flushInterrupt.id, flushPromptInjected: true, flushedInterruptPayloadJson: flushedPayloadJson, abortMetaJson: existingFlush?.abortMetaJson }) });
  await persistStack(frameStep2);
  let flushedPayload: unknown;
  if (flushedPayloadJson !== undefined) {
    flushedPayload = limitConfig.flushInterrupt.schema.parse(JSON.parse(flushedPayloadJson));
  } else {
    const chain = leafId !== null ? [...(await ledgerStore.getMessageChain(leafId))] : [];
    const flushNote = `[LIMIT_EXCEEDED_FLUSH] ${params.tripReason}. Summarize state and emit final structured output.`;
    const lastFrame = chain[chain.length - 1];
    if (lastFrame !== undefined && (lastFrame.canonical.role === 'tool' || lastFrame.canonical.role === 'user')) {
      const updatedLast = await modelDriver.appendToolResultNotes(lastFrame, [flushNote]);
      await ledgerStore.replaceMessageFrame(ctx.runId, updatedLast);
      chain[chain.length - 1] = updatedLast;
    } else {
      const noteFrame = Object.freeze<WireFrameRecord>({ messageId: `msg:${ctx.stepExecId}:flush-prompt`, parentMessageId: leafId, vendorId: modelDriver.vendorId, rawWireFrame: new TextEncoder().encode(flushNote), canonical: Object.freeze({ role: 'user', visibleText: flushNote }), prefixDigest: params.wirePrefix?.systemDigest ?? 'unpinned' });
      await ledgerStore.appendMessageFrame(ctx.runId, noteFrame);
      chain.push(noteFrame);
      leafId = noteFrame.messageId;
    }
    const resp = await modelDriver.invokeTurn({ modelId: modelNode.modelId, effort: 'low', toolChoice: 'none', wirePrefix: params.wirePrefix, roleKey: params.agentFrame.roleKey, history: Object.freeze(chain), outputSchema: limitConfig.flushInterrupt.schema, signal: ctx.signal });
    flushedPayload = limitConfig.flushInterrupt.schema.parse(resp.structuredOutput ?? JSON.parse(resp.canonical.visibleText || '{}'));
    flushedPayloadJson = JSON.stringify(flushedPayload);
    frameStep2 = Object.freeze({ ...frameStep2, leafMessageId: leafId, turnsTaken: frameStep2.turnsTaken + 1, costUsd: frameStep2.costUsd + resp.usage.costUsd, pauseState: Object.freeze({ kind: 'interrupt-flush', interruptId: limitConfig.flushInterrupt.id, flushPromptInjected: true, flushedInterruptPayloadJson: flushedPayloadJson, abortMetaJson: existingFlush?.abortMetaJson }) });
    await persistStack(frameStep2);
  }
  await params.serviceRegistry?.quiesceScopeServices();
  let abortMeta: Record<string, unknown> = {};
  if (limitConfig.abortHook !== undefined) {
    const hookExec = ctx.registry.abortHooks[limitConfig.abortHook.type];
    if (hookExec === undefined) throw new Error(`No AbortHook executor for '${limitConfig.abortHook.type}'.`);
    abortMeta = await hookExec(limitConfig.abortHook as never, { handle: ctx.scopeHandle, runId: ctx.runId, stepExecId: ctx.stepExecId }, ctx as never);
  } else if (params.baseScopeCheckpoint !== undefined && ctx.scope !== undefined && 'supportsCheckpoints' in ctx.scope) {
    await (ctx.scope as CheckpointableScope<THandle, Record<string, unknown>>).restoreCheckpoint(ctx.scopeHandle, params.baseScopeCheckpoint);
  }
  await params.topologyStore?.resetRunOverlay(ctx.runId, { scope: 'step', stepExecId: ctx.stepExecId });
  const frameStep3: AgentContinuationFrame = Object.freeze({ ...frameStep2, accumulatedLessonOutcomes: undefined, bufferedGateRecoveries: undefined, pauseState: Object.freeze({ kind: 'interrupt-flush', interruptId: limitConfig.flushInterrupt.id, flushPromptInjected: true, flushedInterruptPayloadJson: flushedPayloadJson, abortMetaJson: JSON.stringify(abortMeta) }) });
  await persistStack(frameStep3);
  if (params.replacementPromotion !== undefined) {
    const promo = params.replacementPromotion;
    const replacementInput = promo.mapReplacementInput(JSON.parse(params.agentFrame.inputJson || 'null'), flushedPayload, abortMeta);
    await ledgerStore.recordStepTransition({ stepExecId: ctx.stepExecId, status: 'INTERRUPTED', telemetryJson: JSON.stringify({ turnsTaken: frameStep3.turnsTaken, costUsd: frameStep3.costUsd }) });
    await ledgerStore.updateRunInput(ctx.runId, { inputJson: JSON.stringify(replacementInput) });
    await ledgerStore.recordStepStart({ runId: ctx.runId, stepExecId: promo.replacementStepExecId, stepId: promo.stepId, executableId: promo.replacementExecutableId, inputMsgId: leafId, baseScopeCheckpoint: promo.baseScopeCheckpoint, continuationStack: promo.replacementInitialStack ?? Object.freeze([]) });
  }
  return Object.freeze<LimitExceededFlushResult>({ interruptId: limitConfig.flushInterrupt.id, flushedPayload, abortMeta, leafMessageId: leafId, updatedAgentFrame: frameStep3 });
}
