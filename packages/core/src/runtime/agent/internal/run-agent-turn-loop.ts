import type { AgentContinuationFrame } from '../../../ports/agent-continuation-frame.js';
import type { WireToolSchema } from '../../../ports/compiled-wire-prefix.js';
import type { LoopContinuationFrame } from '../../../ports/loop-continuation-frame.js';
import type { ModelTurnResponse } from '../../../ports/model-turn-response.js';
import type { PendingToolBatch, RemainingToolCallRecord } from '../../../ports/pending-tool-batch.js';
import type { TopologyPartitionState } from '../../../ports/topology-partition-state.js';
import type { WireFrameRecord } from '../../../ports/wire-frame-record.js';
import { flushStepLessonOutcomes } from '../../lessons/lesson-distiller-runner.js';
import { executeLimitExceededSequence } from '../../policy/execute-limit-exceeded-flush.js';
import { checkQuantitativeLimits } from '../../policy/internal/match-lease-and-clauses.js';
import {
  buildRoleAndScopeContextFrame,
  computeInRunGroundingDiffs,
} from '../../prefix/compile-wire-prefix.js';
import { collectRoleScopedWireTools } from '../../prefix/internal/collect-prefix-tools.js';
import type { SkillCatalogEntryRecord } from '../../prefix/skill-catalog-entry-record.js';
import type { AgentTurnSessionState } from '../agent-turn-session-state.js';
import { drainPendingToolBatch } from './drain-pending-tool-batch.js';
import { evaluateBeforeStopGate } from './evaluate-before-stop-gate.js';
import { resolveInterruptEdge } from './resolve-interrupt-edge.js';

/**
 * Initializes the Turn-0 `[ROLE_AND_SCOPE_CONTEXT]` wire frame and evaluates `ScopedRuleNode.when.partitions` (`SPEC.md` §3.2.1 & §3.4.1).
 *
 * No-ops when resuming an existing session that already has a non-null `leafMessageId`.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>} session - Active agent turn session state.
 *
 * @returns {Promise<void>} Resolves once the Turn-0 context frame is appended.
 */
export async function initializeAgentContinuationFrame<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
): Promise<void> {
  if (session.agentFrame.leafMessageId !== null || session.agentFrame.turnsTaken > 0) return;
  const injectedIdSet = new Set<string>(session.agentFrame.injectedScopedRuleIds);
  const activePartitionSet = new Set<string>(session.ctx.activePartitions);
  const partitionDirectives: Array<{ readonly id: string; readonly directive: string }> = [];
  for (const rule of session.scopedRules) {
    if (injectedIdSet.has(rule.id)) continue;
    let matchesPartition = false;
    for (const p of rule.when.partitions ?? []) if (activePartitionSet.has(p)) matchesPartition = true;
    if (matchesPartition) {
      injectedIdSet.add(rule.id);
      partitionDirectives.push(Object.freeze({ id: rule.id, directive: typeof rule.directive === 'string' ? rule.directive : JSON.stringify(rule.directive) }));
    }
  }
  const skillCatalog: SkillCatalogEntryRecord[] = [];
  for (const skill of session.skillsById.values()) {
    let highlighted = false;
    for (const p of skill.when?.partitions ?? []) if (activePartitionSet.has(p)) highlighted = true;
    skillCatalog.push(Object.freeze<SkillCatalogEntryRecord>({ skillId: skill.id, description: skill.description, highlighted }));
  }
  const topologyPartitions: TopologyPartitionState[] = [];
  if (session.topologyStore !== undefined) {
    const parts = await session.topologyStore.getPartitions(session.ctx.runId);
    for (const [pid, state] of parts.entries()) if (activePartitionSet.has(pid)) topologyPartitions.push(state);
  }
  const updatedGroundingDiffs = session.wirePrefix !== undefined && session.node.prefixGroup !== undefined
    ? await computeInRunGroundingDiffs({ prefixGroup: session.node.prefixGroup, compiledPrefix: session.wirePrefix, scopeHandle: session.ctx.scopeHandle, registry: session.ctx.registry, resolutionContext: session.ctx })
    : undefined;
  const roleContextText = buildRoleAndScopeContextFrame({
    agentId: session.node.id, roleKey: session.agentFrame.roleKey, activePartitions: session.ctx.activePartitions,
    actorGroundingTexts: session.actorGroundingTexts, actorInstructionTexts: session.actorInstructionTexts,
    skillCatalog, topologyPartitions, updatedGroundingDiffs, scopedRuleDirectives: partitionDirectives, recalledLessons: session.recalledLessons,
  });
  const userPrompt = `${roleContextText}\n\n[INPUT]\n${session.agentFrame.inputJson}`;
  const turn0MsgId = `msg:${session.ctx.stepExecId}:turn-0`;
  const seededLeafId = session.ctx.seededHistory?.[session.ctx.seededHistory.length - 1]?.messageId ?? null;
  if (session.ledgerStore !== undefined) await session.ledgerStore.appendMessageFrame(session.ctx.runId, Object.freeze<WireFrameRecord>({ messageId: turn0MsgId, parentMessageId: seededLeafId, vendorId: session.modelNode.vendor, rawWireFrame: new TextEncoder().encode(userPrompt), canonical: Object.freeze({ role: 'user', visibleText: userPrompt }), prefixDigest: session.wirePrefix?.systemDigest ?? 'unpinned' }));
  session.agentFrame = Object.freeze<AgentContinuationFrame>({ ...session.agentFrame, leafMessageId: turn0MsgId, injectedScopedRuleIds: Object.freeze(Array.from(injectedIdSet)) });
}

/**
 * Invokes `ModelDriver.invokeTurn` with `PoolManager` seat affinity, HTTP `429` failover, and loop-aware telemetry accounting (`SPEC.md` §3.2 & §3.8).
 *
 * Appends the returned assistant `WireFrameRecord` to `LedgerStore` and updates `agentFrame` and any enclosing `loop-frame`.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>} session - Active agent turn session state.
 *
 * @returns {Promise<ModelTurnResponse>} Validated model turn response.
 */
export async function invokeModelTurnWithFailover<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
): Promise<ModelTurnResponse> {
  const history = session.ledgerStore !== undefined && session.agentFrame.leafMessageId !== null ? await session.ledgerStore.getMessageChain(session.agentFrame.leafMessageId) : [];
  const prefixTools = session.wirePrefix?.wireToolSchemasByRoleKey[session.agentFrame.roleKey] ?? session.wirePrefix?.wireToolSchemasByRoleKey['*'];
  const wireToolSchemas: readonly WireToolSchema[] = prefixTools !== undefined && prefixTools.length > 0 ? prefixTools : collectRoleScopedWireTools(session.node as never, Array.from(session.skillsById.values()));
  const modelWithSeat = session.modelNode as { readonly account?: unknown; readonly accountPool?: { readonly type?: string; readonly id: string } };
  const seatPool = modelWithSeat.accountPool ?? (modelWithSeat.account !== undefined && (modelWithSeat.account as { readonly type?: string }).type === 'harness:pool' ? (modelWithSeat.account as { readonly id: string }) : undefined);
  let seat = seatPool !== undefined ? session.poolManager.selectSeat(seatPool as never, session.ctx.runId, Date.now()) : modelWithSeat.account;
  const startMs = Date.now();
  let response: ModelTurnResponse;
  try {
    response = await session.modelDriver.invokeTurn({ modelId: session.modelNode.modelId, accountConfig: seat as never, effort: session.modelNode.effort, toolChoice: 'auto', wirePrefix: session.wirePrefix, roleKey: session.agentFrame.roleKey, history, wireToolSchemas, outputSchema: session.node.outputSchema, signal: session.ctx.signal });
  } catch (err) {
    const rateErr = err as { readonly status?: number; readonly resetAtMs?: number };
    if (seatPool !== undefined && seat !== undefined && (rateErr.status === 429 || rateErr.resetAtMs !== undefined)) {
      session.poolManager.recordRateLimit429((seatPool as { readonly id: string }).id, (seat as { readonly id: string }).id, rateErr.resetAtMs ?? Date.now() + 60_000);
      seat = session.poolManager.selectSeat(seatPool as never, session.ctx.runId, Date.now());
      response = await session.modelDriver.invokeTurn({ modelId: session.modelNode.modelId, accountConfig: seat as never, effort: session.modelNode.effort, toolChoice: 'auto', wirePrefix: session.wirePrefix, roleKey: session.agentFrame.roleKey, history, wireToolSchemas, outputSchema: session.node.outputSchema, signal: session.ctx.signal });
    } else throw err;
  }
  const latencyMs = Math.max(0, Date.now() - startMs);
  const assistantMsgId = `msg:${session.ctx.stepExecId}:assistant:${String(session.agentFrame.turnsTaken + 1)}`;
  if (session.ledgerStore !== undefined) await session.ledgerStore.appendMessageFrame(session.ctx.runId, Object.freeze<WireFrameRecord>({ messageId: assistantMsgId, parentMessageId: session.agentFrame.leafMessageId, vendorId: session.modelNode.vendor, rawWireFrame: response.wireFrame, canonical: response.canonical, prefixDigest: session.wirePrefix?.systemDigest ?? 'unpinned' }));
  session.agentFrame = Object.freeze<AgentContinuationFrame>({ ...session.agentFrame, leafMessageId: assistantMsgId, turnsTaken: session.agentFrame.turnsTaken + 1, costUsd: session.agentFrame.costUsd + response.usage.costUsd, elapsedDurationMs: session.agentFrame.elapsedDurationMs + latencyMs });
  for (let idx = 0; idx < session.outerFrames.length; idx += 1) {
    const outer = session.outerFrames[idx];
    if (outer?.kind === 'loop-frame') {
      const isAct = outer.phase === 'act';
      session.outerFrames[idx] = Object.freeze<LoopContinuationFrame>({ ...outer, preservedActLeafMessageId: isAct ? assistantMsgId : outer.preservedActLeafMessageId, actTurnsTaken: isAct ? outer.actTurnsTaken + 1 : outer.actTurnsTaken, actCostUsd: isAct ? outer.actCostUsd + response.usage.costUsd : outer.actCostUsd, actElapsedDurationMs: isAct ? outer.actElapsedDurationMs + latencyMs : outer.actElapsedDurationMs, turnsTaken: outer.turnsTaken + 1, costUsd: outer.costUsd + response.usage.costUsd, elapsedDurationMs: outer.elapsedDurationMs + latencyMs });
    }
  }
  return response;
}

/**
 * Initializes or resumes `PendingToolBatch` (or reacquires active skill services when no batch is pending) and drains it in `(1..k)` order (`SPEC.md` §3.5).
 *
 * Propagates step suspension or unhandled/replacing interrupts thrown during tool batch draining.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>} session    - Active agent turn session state.
 * @param {ModelTurnResponse}                         [response] - Assistant turn response containing `canonical.toolCalls`, or `undefined` on initial resume.
 *
 * @returns {Promise<TOut | undefined>} Replacement output when a standalone `.replaceWith()` edge completes, or `undefined`.
 */
export async function prepareAndDrainTurnToolBatch<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
  response?: ModelTurnResponse,
): Promise<TOut | undefined> {
  let batch: PendingToolBatch | undefined;
  if (response !== undefined) {
    const rawCalls: RemainingToolCallRecord[] = (response.canonical.toolCalls ?? []).map((tc) => Object.freeze<RemainingToolCallRecord>({ callId: tc.id, toolName: tc.name, argsJson: tc.argsJson }));
    batch = Object.freeze<PendingToolBatch>({ completedResults: Object.freeze([]), blockedCalls: Object.freeze([]), remainingCalls: Object.freeze(rawCalls) });
  } else {
    const ps = session.agentFrame.pauseState;
    const pending = (ps.kind === 'tool-batch' || ps.kind === 'adjudication' || ps.kind === 'prerequisite-wait') ? ps.pendingToolBatch : undefined;
    if (pending !== undefined && (pending.remainingCalls.length > 0 || pending.completedResults.length > 0)) batch = pending;
    else if (session.agentFrame.activeSkillIds.length > 0) {
      const notes = await session.serviceRegistry.reacquireActiveSkillServices({ runId: session.ctx.runId, scopeKey: session.ctx.stepExecId, scopeHandle: session.ctx.scopeHandle, activeSkillIds: session.agentFrame.activeSkillIds, skillsById: session.skillsById, driverContext: { registry: session.ctx.registry, resolveEnv: (v) => session.ctx.resolveEnv(v), getRunner: (n) => session.ctx.getRunner(n) } });
      if (notes.length > 0 && session.ledgerStore !== undefined && session.agentFrame.leafMessageId !== null) {
        const chain = await session.ledgerStore.getMessageChain(session.agentFrame.leafMessageId);
        const last = chain[chain.length - 1];
        if (last !== undefined && (last.canonical.role === 'tool' || last.canonical.role === 'user')) await session.ledgerStore.replaceMessageFrame(session.ctx.runId, await session.modelDriver.appendToolResultNotes(last, notes));
      }
    }
  }
  if (batch === undefined) return undefined;
  const drainOut = await drainPendingToolBatch(session, batch);
  if (drainOut.status === 'suspended') {
    throw Object.assign(new Error(`Step '${session.ctx.stepExecId}' in run '${session.ctx.runId}' suspended on prerequisites.`), { code: 'HARNESS_STEP_SUSPENDED' });
  }
  if (drainOut.status === 'interrupted' && drainOut.interruptResolution !== undefined) {
    const intrRes = drainOut.interruptResolution;
    if (session.laneId === undefined && intrRes.status === 'replace' && intrRes.replaceHandler?.mode === 'replace') {
      const repInput = intrRes.replaceHandler.mapReplacementInput(session.validatedInput, intrRes.payload, { costUsd: 0, turnsTaken: session.agentFrame.turnsTaken, durationMs: session.agentFrame.elapsedDurationMs, custom: {}, abortMeta: {} });
      const repOut = await session.executeChildStep(intrRes.replaceHandler.replacementExecutable, repInput, session.ctx);
      if (repOut.status === 'completed') return repOut.output as TOut;
    }
    throw Object.assign(new Error(`Unhandled or replacing interrupt '${intrRes.interruptId}' in agent '${session.node.id}'.`), { interruptResolution: intrRes });
  }
  return undefined;
}

/**
 * Runs the `H.agent` turn loop until the model produces a completion output that passes `evaluateBeforeStopGate` (`SPEC.md` §3.7.1).
 *
 * Enforces quantitative quota tripwires, resumes mid-tool-batch states on crash recovery, and flushes standalone lesson outcomes on pass.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>} session - Active agent turn session state.
 *
 * @returns {Promise<TOut>} Schema-validated agent output after passing all `beforeStop` checks.
 */
export async function runAgentTurnLoop<TIn, TOut, THandle>(session: AgentTurnSessionState<TIn, TOut, THandle>): Promise<TOut> {
  await initializeAgentContinuationFrame(session);
  const resumedRep = await prepareAndDrainTurnToolBatch(session);
  if (resumedRep !== undefined) return resumedRep;
  for (;;) {
    const loopFrame = session.outerFrames.find((f): f is LoopContinuationFrame => f.kind === 'loop-frame');
    const tripwireMetrics = loopFrame?.phase === 'act' ? { turnsTaken: loopFrame.actTurnsTaken, costUsd: loopFrame.actCostUsd, elapsedDurationMs: loopFrame.actElapsedDurationMs } : { turnsTaken: session.agentFrame.turnsTaken, costUsd: session.agentFrame.costUsd, elapsedDurationMs: session.agentFrame.elapsedDurationMs };
    const limitReason = checkQuantitativeLimits(session.node.policy, tripwireMetrics);
    if (limitReason !== undefined) {
      if (session.node.policy?.onLimitExceeded === undefined) throw new Error(`Quantitative policy limit exceeded on agent '${session.node.id}' in run '${session.ctx.runId}' (step '${session.ctx.stepExecId}'): ${limitReason}.`);
      const limCfg = session.node.policy.onLimitExceeded;
      const hasReplaceAbortHook = session.node.onInterruptHandlers.some((h) => h.interrupt.id === limCfg.flushInterrupt.id && h.mode === 'replace' && h.abortHook !== undefined);
      const flushPayload = session.ledgerStore !== undefined ? (await executeLimitExceededSequence({ agentFrame: session.agentFrame, outerFrames: session.outerFrames, limitConfig: limCfg, modelNode: session.modelNode, modelDriver: session.modelDriver, wirePrefix: session.wirePrefix, ledgerStore: session.ledgerStore, continuationQueue: session.continuationQueue, topologyStore: session.topologyStore, serviceRegistry: session.serviceRegistry, baseScopeCheckpoint: hasReplaceAbortHook ? undefined : session.baseScopeCheckpoint, tripReason: limitReason, ctx: session.ctx })).flushedPayload : Object.freeze({ reason: limitReason, ...tripwireMetrics, observedEffects: session.agentFrame.observedEffects });
      const intrRes = await resolveInterruptEdge(session, limCfg.flushInterrupt.id, flushPayload);
      if (session.laneId === undefined && intrRes.status === 'replace' && intrRes.replaceHandler?.mode === 'replace') {
        const repOut = await session.executeChildStep(intrRes.replaceHandler.replacementExecutable, intrRes.replaceHandler.mapReplacementInput(session.validatedInput, intrRes.payload, { costUsd: 0, turnsTaken: session.agentFrame.turnsTaken, durationMs: session.agentFrame.elapsedDurationMs, custom: {}, abortMeta: {} }), session.ctx);
        if (repOut.status === 'completed') return repOut.output as TOut;
      }
      if (intrRes.status !== 'resumed') throw Object.assign(new Error(limitReason), { interruptResolution: intrRes, isLimitExceeded: true });
    }
    const response = await invokeModelTurnWithFailover(session);
    if ((response.canonical.toolCalls?.length ?? 0) > 0) {
      const repResult = await prepareAndDrainTurnToolBatch(session, response);
      if (repResult !== undefined) return repResult;
      continue;
    }
    let parsedVisible: unknown = response.canonical.visibleText;
    if (response.structuredOutput === undefined && response.canonical.visibleText.trim().startsWith('{')) parsedVisible = JSON.parse(response.canonical.visibleText);
    const rawCandidate = response.structuredOutput !== undefined ? response.structuredOutput : parsedVisible;
    const validatedOutput = session.node.outputSchema.parse(rawCandidate);
    if (!(await evaluateBeforeStopGate(session, rawCandidate)).passed) continue;
    for (let idx = 0; idx < session.outerFrames.length; idx += 1) {
      const outer = session.outerFrames[idx];
      if (outer?.kind === 'loop-frame' && outer.phase === 'act') session.outerFrames[idx] = Object.freeze<LoopContinuationFrame>({ ...outer, preservedActLeafMessageId: session.agentFrame.leafMessageId, grantedLoopLeases: session.agentFrame.activeLeases, activeSkillIds: session.agentFrame.activeSkillIds, activeSkillActivations: session.agentFrame.activeSkillActivations, observedEffects: session.agentFrame.observedEffects, injectedScopedRuleIds: session.agentFrame.injectedScopedRuleIds, bufferedGateRecoveries: session.agentFrame.bufferedGateRecoveries, accumulatedLessonOutcomes: Object.freeze({ ...outer.accumulatedLessonOutcomes, ...session.accumulatedLessonOutcomes }) });
    }
    if (loopFrame === undefined && !session.outerFrames.some((f) => f.kind === 'speculate-frame') && session.lessonStore !== undefined && session.node.lessons !== undefined && session.node.lessons.recordOutcomes !== false) await flushStepLessonOutcomes({ lessonsNode: session.node.lessons.node, lessonStore: session.lessonStore, accumulatedOutcomes: session.accumulatedLessonOutcomes });
    if ((session.node.model as { readonly type?: string }).type === 'harness:pool') session.poolManager.recordModelOutcome((session.node.model as { readonly id: string }).id, session.modelNode.modelId, true);
    return validatedOutput;
  }
}
