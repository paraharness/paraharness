import type { AgentContinuationFrame } from '../../../ports/agent-continuation-frame.js';
import type { WireToolSchema } from '../../../ports/compiled-wire-prefix.js';
import type { LoopContinuationFrame } from '../../../ports/loop-continuation-frame.js';
import type { ModelTurnResponse } from '../../../ports/model-turn-response.js';
import type { PendingToolBatch, RemainingToolCallRecord } from '../../../ports/pending-tool-batch.js';
import type { TopologyPartitionState } from '../../../ports/topology-partition-state.js';
import type { WireFrameRecord } from '../../../ports/wire-frame-record.js';
import { zodToJsonSchema } from '../../../schemas/zod-to-json-schema.js';
import { flushStepLessonOutcomes } from '../../lessons/lesson-distiller-runner.js';
import { evaluatePreFlightToolBatch } from '../../policy/evaluate-policy-guards.js';
import { checkQuantitativeLimits } from '../../policy/internal/match-lease-and-clauses.js';
import { buildRoleAndScopeContextFrame } from '../../prefix/compile-wire-prefix.js';
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
  const injectedIds = [...session.agentFrame.injectedScopedRuleIds];
  const partitionDirectives: Array<{ readonly id: string; readonly directive: string }> = [];
  for (const rule of session.scopedRules) {
    if (injectedIds.includes(rule.id)) continue;
    const ruleParts = rule.when.partitions ?? [];
    if (ruleParts.some((p) => session.ctx.activePartitions.includes(p))) {
      injectedIds.push(rule.id);
      partitionDirectives.push(Object.freeze({ id: rule.id, directive: typeof rule.directive === 'string' ? rule.directive : JSON.stringify(rule.directive) }));
    }
  }
  const topologyPartitions: TopologyPartitionState[] = [];
  if (session.topologyStore !== undefined) {
    const parts = await session.topologyStore.getPartitions(session.ctx.runId);
    for (const [pid, state] of parts.entries()) {
      if (session.ctx.activePartitions.includes(pid)) topologyPartitions.push(state);
    }
  }
  const roleContextText = buildRoleAndScopeContextFrame({
    agentId: session.node.id,
    roleKey: session.agentFrame.roleKey,
    activePartitions: session.ctx.activePartitions,
    topologyPartitions,
    scopedRuleDirectives: partitionDirectives,
    recalledLessons: session.recalledLessons,
  });
  const userPrompt = `${roleContextText}\n\n[INPUT]\n${session.agentFrame.inputJson}`;
  const turn0MsgId = `msg:${session.ctx.stepExecId}:turn-0`;
  if (session.ledgerStore !== undefined) {
    await session.ledgerStore.appendMessageFrame(session.ctx.runId, Object.freeze<WireFrameRecord>({ messageId: turn0MsgId, parentMessageId: null, vendorId: session.modelNode.vendor, rawWireFrame: new TextEncoder().encode(userPrompt), canonical: Object.freeze({ role: 'user', visibleText: userPrompt }), prefixDigest: session.wirePrefix?.systemDigest ?? 'unpinned' }));
  }
  session.agentFrame = Object.freeze<AgentContinuationFrame>({ ...session.agentFrame, leafMessageId: turn0MsgId, injectedScopedRuleIds: Object.freeze(injectedIds) });
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
  const wireToolSchemas: WireToolSchema[] = [...(session.wirePrefix?.wireToolSchemasByRoleKey[session.agentFrame.roleKey] ?? session.wirePrefix?.wireToolSchemasByRoleKey['*'] ?? [])];
  if (wireToolSchemas.length === 0) {
    for (const [toolName, toolNode] of session.toolsByName.entries()) {
      const ownerSkill = session.skillOwnerByToolName.get(toolName);
      if (ownerSkill === undefined || session.agentFrame.activeSkillIds.includes(ownerSkill)) wireToolSchemas.push(Object.freeze<WireToolSchema>({ name: toolName, description: toolNode.description, inputJsonSchema: zodToJsonSchema(toolNode.inputSchema) as Readonly<Record<string, unknown>> }));
    }
  }
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
  const latencyMs = Math.max(0, Date.now() - startMs), assistantMsgId = `msg:${session.ctx.stepExecId}:assistant:${String(session.agentFrame.turnsTaken + 1)}`;
  if (session.ledgerStore !== undefined) await session.ledgerStore.appendMessageFrame(session.ctx.runId, Object.freeze<WireFrameRecord>({ messageId: assistantMsgId, parentMessageId: session.agentFrame.leafMessageId, vendorId: session.modelNode.vendor, rawWireFrame: response.wireFrame, canonical: response.canonical, prefixDigest: session.wirePrefix?.systemDigest ?? 'unpinned' }));
  session.agentFrame = Object.freeze<AgentContinuationFrame>({ ...session.agentFrame, leafMessageId: assistantMsgId, turnsTaken: session.agentFrame.turnsTaken + 1, costUsd: session.agentFrame.costUsd + response.usage.costUsd, elapsedDurationMs: session.agentFrame.elapsedDurationMs + latencyMs });
  for (let idx = 0; idx < session.outerFrames.length; idx += 1) {
    const outer = session.outerFrames[idx];
    if (outer?.kind === 'loop-frame') {
      const isAct = outer.phase === 'act';
      session.outerFrames[idx] = Object.freeze<LoopContinuationFrame>({ ...outer, actTurnsTaken: isAct ? outer.actTurnsTaken + 1 : outer.actTurnsTaken, actCostUsd: isAct ? outer.actCostUsd + response.usage.costUsd : outer.actCostUsd, actElapsedDurationMs: isAct ? outer.actElapsedDurationMs + latencyMs : outer.actElapsedDurationMs, turnsTaken: outer.turnsTaken + 1, costUsd: outer.costUsd + response.usage.costUsd, elapsedDurationMs: outer.elapsedDurationMs + latencyMs });
    }
  }
  return response;
}

/**
 * Pre-evaluates an assistant turn's tool calls to batch `(i..k)` calls failing the same `'raise-interrupt'` clause $C$ before draining (`SPEC.md` §3.5).
 *
 * Executes any matched interrupt handler edge and attaches `adjudicationFeedback` to the batch before calling `drainPendingToolBatch`.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>} session  - Active agent turn session state.
 * @param {ModelTurnResponse}                         response - Assistant turn response containing `canonical.toolCalls`.
 *
 * @returns {Promise<void>} Resolves once the tool batch finishes draining.
 */
export async function prepareAndDrainTurnToolBatch<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
  response: ModelTurnResponse,
): Promise<void> {
  const rawCalls: RemainingToolCallRecord[] = (response.canonical.toolCalls ?? []).map((tc) => Object.freeze<RemainingToolCallRecord>({ callId: tc.id, toolName: tc.name, argsJson: tc.argsJson }));
  const preEval = await evaluatePreFlightToolBatch({ policy: session.node.policy, remainingCalls: rawCalls, toolsByName: session.toolsByName, activeLeases: session.agentFrame.activeLeases, ctx: session.ctx });
  let batch: PendingToolBatch = Object.freeze<PendingToolBatch>({ completedResults: Object.freeze([]), blockedCalls: preEval.blockedCalls ?? Object.freeze([]), remainingCalls: preEval.updatedRemainingCalls ?? rawCalls, activeInterruptCallId: preEval.blockedCalls?.[0]?.callId });
  if (preEval.status === 'raise-interrupt' && preEval.raisedInterrupt !== undefined && (preEval.blockedCalls?.length ?? 0) > 0) {
    session.agentFrame = Object.freeze<AgentContinuationFrame>({ ...session.agentFrame, pauseState: Object.freeze({ kind: 'tool-batch', pendingToolBatch: batch }) });
    const intrRes = await resolveInterruptEdge(session, preEval.raisedInterrupt.id, preEval.interruptPayload);
    if (intrRes.status !== 'resumed') {
      const err = new Error(`Unhandled or replacing interrupt '${intrRes.interruptId}' in agent '${session.node.id}'.`) as Error & { interruptResolution?: unknown };
      err.interruptResolution = intrRes;
      throw err;
    }
    batch = Object.freeze<PendingToolBatch>({ ...batch, adjudicationFeedback: intrRes.feedback, activeInterruptCallId: undefined });
  }
  const drainOut = await drainPendingToolBatch(session, batch);
  if (drainOut.status === 'suspended') {
    const suspErr = new Error(`Step '${session.ctx.stepExecId}' suspended on prerequisites.`) as Error & { code?: string };
    suspErr.code = 'HARNESS_STEP_SUSPENDED';
    throw suspErr;
  }
  if (drainOut.status === 'interrupted' && drainOut.interruptResolution !== undefined) {
    const err = new Error(`Unhandled or replacing interrupt '${drainOut.interruptResolution.interruptId}' in agent '${session.node.id}'.`) as Error & { interruptResolution?: unknown };
    err.interruptResolution = drainOut.interruptResolution;
    throw err;
  }
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
export async function runAgentTurnLoop<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
): Promise<TOut> {
  await initializeAgentContinuationFrame(session);
  if (session.agentFrame.pauseState.kind === 'tool-batch' && session.agentFrame.pauseState.pendingToolBatch.remainingCalls.length > 0) {
    const resumedOut = await drainPendingToolBatch(session, session.agentFrame.pauseState.pendingToolBatch);
    if (resumedOut.status === 'suspended') { const e = new Error('Suspended') as Error & { code?: string }; e.code = 'HARNESS_STEP_SUSPENDED'; throw e; }
  }
  for (;;) {
    const loopFrame = session.outerFrames.find((f): f is LoopContinuationFrame => f.kind === 'loop-frame');
    const tripwireMetrics = loopFrame?.phase === 'act' ? { turnsTaken: loopFrame.actTurnsTaken, costUsd: loopFrame.actCostUsd, elapsedDurationMs: loopFrame.actElapsedDurationMs } : { turnsTaken: session.agentFrame.turnsTaken, costUsd: session.agentFrame.costUsd, elapsedDurationMs: session.agentFrame.elapsedDurationMs };
    const limitReason = checkQuantitativeLimits(session.node.policy, tripwireMetrics);
    if (limitReason !== undefined && session.node.policy?.onLimitExceeded !== undefined) {
      const limCfg = session.node.policy.onLimitExceeded, intrPayload = Object.freeze({ reason: limitReason, ...tripwireMetrics, observedEffects: session.agentFrame.observedEffects });
      const intrRes = await resolveInterruptEdge(session, limCfg.flushInterrupt.id, intrPayload);
      if (intrRes.status !== 'resumed') { const err = new Error(limitReason) as Error & { interruptResolution?: unknown; isLimitExceeded?: boolean }; err.interruptResolution = intrRes; err.isLimitExceeded = true; throw err; }
    }
    const response = await invokeModelTurnWithFailover(session);
    if ((response.canonical.toolCalls?.length ?? 0) > 0) { await prepareAndDrainTurnToolBatch(session, response); continue; }
    const rawCandidate = response.structuredOutput !== undefined ? response.structuredOutput : (() => { try { return JSON.parse(response.canonical.visibleText); } catch { return response.canonical.visibleText; } })();
    const validatedOutput = session.node.outputSchema.parse(rawCandidate);
    const gateRes = await evaluateBeforeStopGate(session, validatedOutput);
    if (!gateRes.passed) continue;
    const isSpeculative = session.outerFrames.some((f) => f.kind === 'speculate-frame');
    if (loopFrame === undefined && !isSpeculative && session.lessonStore !== undefined && session.node.lessons !== undefined) await flushStepLessonOutcomes({ lessonsNode: session.node.lessons.node, lessonStore: session.lessonStore, accumulatedOutcomes: session.accumulatedLessonOutcomes });
    if ((session.node.model as { readonly type?: string }).type === 'harness:pool') session.poolManager.recordModelOutcome((session.node.model as { readonly id: string }).id, session.modelNode.modelId, true);
    return validatedOutput;
  }
}
