import type { AgentNode } from '../../../ast/agent-node.js';
import type { ToolASTNode } from '../../../ast/domain-ast.types.js';
import type { AgentContinuationFrame } from '../../../ports/agent-continuation-frame.js';
import type { BranchableScope } from '../../../ports/branchable-scope.js';
import type { CheckpointableScope } from '../../../ports/checkpointable-scope.js';
import type { ContinuationFrame } from '../../../ports/continuation-frame.types.js';
import type { LoopContinuationFrame } from '../../../ports/loop-continuation-frame.js';
import type { PendingToolBatch, RemainingToolCallRecord } from '../../../ports/pending-tool-batch.js';
import type { RuntimeDriverContext } from '../../../ports/runtime-driver-context.js';
import type { ToolEffect } from '../../../ports/tool-effect.js';
import type { WireFrameRecord } from '../../../ports/wire-frame-record.js';
import { executeForkBatch, executeResumeForkBatch } from '../../fork/execute-fork-batch.js';
import { executeAddDependencies, executeSpawnTasks, executeUpdatePartitionContract } from '../../plan/execute-plan-mutation.js';
import type { SpawnTaskInputEntry } from '../../plan/plan-mutation-params.js';
import { evaluatePreFlightToolBatch, executePostFlightSandboxedTool } from '../../policy/evaluate-policy-guards.js';
import { executeSpeculateTournament } from '../../speculate/execute-speculate-tournament.js';
import type {
  AgentTurnSessionState,
  DrainToolBatchOutcome,
  InterruptEdgeResolution,
} from '../agent-turn-session-state.js';
import { resolveInterruptEdge } from './resolve-interrupt-edge.js';

/**
 * Evaluates reactive `ScopedRuleNode.when.effects` predicates against a tool call's effects and appends newly triggered directives (`SPEC.md` §3.4.1).
 *
 * Records newly matched rule IDs in `session.agentFrame.injectedScopedRuleIds` so each scoped rule is injected at most once.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>} session - Active agent turn session state.
 * @param {readonly ToolEffect[]}                     effects - Observed effects from the current tool call.
 * @param {string}                                    content - Serialized tool result text before rule injection.
 *
 * @returns {Promise<string>} Tool result text with any newly triggered scoped rule directives appended.
 */
export async function applyReactiveScopedRulesAndRecordEffects<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
  effects: readonly ToolEffect[],
  content: string,
): Promise<string> {
  if (effects.length === 0) return content;
  const injectedIds = [...session.agentFrame.injectedScopedRuleIds], appendedDirectives: string[] = [];
  for (const rule of session.scopedRules) {
    if (injectedIds.includes(rule.id)) continue;
    const matcher = rule.when.effects;
    const matcherExec = matcher !== undefined ? session.ctx.registry.effectMatchers[matcher.type] : undefined;
    let matched = false;
    if (matcherExec !== undefined && matcher !== undefined) {
      for (const eff of effects) { if (await matcherExec(matcher as never, eff, session.ctx as never)) { matched = true; break; } }
    }
    if (matched) {
      injectedIds.push(rule.id);
      const dirText = typeof rule.directive === 'string' ? rule.directive : JSON.stringify(rule.directive);
      appendedDirectives.push(`[SCOPED_RULE: ${rule.id}]\n${dirText}`);
    }
  }
  const mergedEffects = Object.freeze([...session.agentFrame.observedEffects, ...effects]);
  session.agentFrame = Object.freeze<AgentContinuationFrame>({ ...session.agentFrame, observedEffects: mergedEffects, injectedScopedRuleIds: Object.freeze(injectedIds) });
  for (let idx = 0; idx < session.outerFrames.length; idx += 1) {
    const outer = session.outerFrames[idx];
    if (outer?.kind === 'loop-frame' && outer.phase === 'act') {
      session.outerFrames[idx] = Object.freeze<LoopContinuationFrame>({ ...outer, observedEffects: Object.freeze([...outer.observedEffects, ...effects]), injectedScopedRuleIds: Object.freeze([...new Set([...outer.injectedScopedRuleIds, ...injectedIds])]) });
    }
  }
  return appendedDirectives.length > 0 ? `${content}\n${appendedDirectives.join('\n')}` : content;
}

/**
 * Executes built-in runtime skill (`activateSkill`, `completeSkill`) and capability (`fork`, `resumeFork`, `speculate`, `spawnTasks`, `addDependencies`, `updatePartitionContract`, `escalate`) tools (`SPEC.md` §3.4.2 & §3.7.2).
 *
 * Returns `undefined` when `call.toolName` is an external adapter tool rather than a built-in harness tool.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>} session - Active agent turn session state.
 * @param {RemainingToolCallRecord}                   call    - Tool call record being dispatched.
 * @param {PendingToolBatch}                          batch   - Current `PendingToolBatch` state.
 *
 * @returns {Promise<{ readonly status: 'completed' | 'suspended' | 'interrupted'; readonly content: string; readonly isError: boolean; readonly interruptResolution?: InterruptEdgeResolution<THandle> } | undefined>} Built-in execution outcome, or `undefined`.
 */
export async function handleBuiltInSkillAndCapabilityTools<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
  call: RemainingToolCallRecord,
  batch: PendingToolBatch,
): Promise<{ readonly status: 'completed' | 'suspended' | 'interrupted'; readonly content: string; readonly isError: boolean; readonly interruptResolution?: InterruptEdgeResolution<THandle> } | undefined> {
  const args = JSON.parse(call.argsJson || '{}') as Record<string, unknown>;
  const drvCtx: RuntimeDriverContext = { registry: session.ctx.registry, resolveEnv: (v) => (typeof v === 'string' ? v : undefined), getRunner: (n) => { const f = session.ctx.registry.runners[n.type]; if (f === undefined) throw new Error(n.type); return f(n as never); } };
  if (call.toolName === 'activateSkill') {
    const skillId = String(args['skillId'] ?? args['id'] ?? ''), skill = session.skillsById.get(skillId);
    if (skill === undefined) return Object.freeze({ status: 'completed', content: `Unknown skill '${skillId}'.`, isError: true });
    await session.serviceRegistry.acquireSkillServices({ runId: session.ctx.runId, scopeKey: session.ctx.stepExecId, scopeHandle: session.ctx.scopeHandle, skill, driverContext: drvCtx });
    const activeIds = session.agentFrame.activeSkillIds.includes(skillId) ? session.agentFrame.activeSkillIds : Object.freeze([...session.agentFrame.activeSkillIds, skillId]);
    const activations = Object.freeze({ ...session.agentFrame.activeSkillActivations, [skillId]: Object.freeze({ messageId: session.agentFrame.leafMessageId ?? 'turn-0', callId: call.callId }) });
    session.agentFrame = Object.freeze<AgentContinuationFrame>({ ...session.agentFrame, activeSkillIds: activeIds, activeSkillActivations: activations });
    for (let idx = 0; idx < session.outerFrames.length; idx += 1) { const outer = session.outerFrames[idx]; if (outer?.kind === 'loop-frame' && outer.phase === 'act') session.outerFrames[idx] = Object.freeze<LoopContinuationFrame>({ ...outer, activeSkillIds: activeIds, activeSkillActivations: activations }); }
    const instrText = typeof skill.instructions === 'string' ? skill.instructions : JSON.stringify(skill.instructions);
    return Object.freeze({ status: 'completed', content: `[SKILL_ACTIVATED: ${skillId}]\n${instrText}`, isError: false });
  }
  if (call.toolName === 'completeSkill') {
    const skillId = String(args['skillId'] ?? args['id'] ?? ''), summary = String(args['summary'] ?? ''), actCoord = session.agentFrame.activeSkillActivations[skillId];
    await session.serviceRegistry.releaseSkillServices(session.ctx.stepExecId, skillId);
    if (actCoord !== undefined && session.ledgerStore !== undefined) await session.ledgerStore.markFrameTombstone(session.ctx.runId, actCoord.messageId, actCoord.callId, summary);
    const nextActs = { ...session.agentFrame.activeSkillActivations }; delete nextActs[skillId];
    session.agentFrame = Object.freeze<AgentContinuationFrame>({ ...session.agentFrame, activeSkillIds: Object.freeze(session.agentFrame.activeSkillIds.filter((id) => id !== skillId)), activeSkillActivations: Object.freeze(nextActs) });
    return Object.freeze({ status: 'completed', content: `[SKILL_COMPLETED: ${skillId}] ${summary}`, isError: false });
  }
  const scopeFactory = session.ctx.scopeNode !== undefined ? session.ctx.registry.scopes[session.ctx.scopeNode.type] : undefined, scopeDriver = (scopeFactory !== undefined && session.ctx.scopeNode !== undefined ? scopeFactory(session.ctx.scopeNode as never, drvCtx) : undefined) as BranchableScope<THandle, Record<string, unknown>, Record<string, unknown>>;
  const forkCap = session.node.capabilities?.forks.find((f) => f.toolName === call.toolName);
  if (forkCap !== undefined || call.toolName === 'resumeFork') { const fParams = { parentNode: session.node as AgentNode<unknown, unknown, THandle>, parentInput: session.validatedInput, parentLeafMessageId: session.agentFrame.leafMessageId, outerFrames: [...session.outerFrames, session.agentFrame], forkCalls: forkCap !== undefined ? [{ callId: call.callId, forkId: String(args['forkId'] ?? `${call.callId}:0`), capability: forkCap as never, argsJson: call.argsJson }] : undefined, resumeRequest: call.toolName === 'resumeFork' ? { callId: call.callId, suspendedForkIds: (args['suspendedForkIds'] as readonly string[] | undefined) ?? [], action: (args['action'] as 'resume' | 'abort' | undefined) ?? 'resume', resolutionSummary: String(args['resolutionSummary'] ?? '') } : undefined, branchableScope: scopeDriver, lockManager: session.lockManager, continuationQueue: session.continuationQueue, ledgerStore: session.ledgerStore as NonNullable<typeof session.ledgerStore>, lessonStore: session.lessonStore, poolManager: session.poolManager, modelDriver: session.modelDriver, wirePrefix: session.wirePrefix, humanAdaptersById: session.humanAdaptersById, ctx: session.ctx, executeChildStep: session.executeChildStep }; const fRes = call.toolName === 'resumeFork' ? await executeResumeForkBatch(fParams) : await executeForkBatch(fParams); if (fRes.batchFrame.forks.some((f) => f.conflictCheckArmed)) session.agentFrame = Object.freeze<AgentContinuationFrame>({ ...session.agentFrame, conflictCheckArmed: true }); const outEntry = fRes.toolResultsByCallId.get(call.callId); return Object.freeze({ status: 'completed', content: outEntry?.content ?? JSON.stringify(fRes.batchFrame), isError: outEntry?.isError ?? false }); }
  const specCap = session.node.capabilities?.speculations.find((s) => s.toolName === call.toolName);
  if (specCap !== undefined) { const sRes = await executeSpeculateTournament({ parentNode: session.node as AgentNode<unknown, unknown, THandle>, parentInput: session.validatedInput, callId: call.callId, capability: specCap as never, argsJson: call.argsJson, outerFrames: [...session.outerFrames, session.agentFrame], branchableScope: scopeDriver, lockManager: session.lockManager, continuationQueue: session.continuationQueue, ledgerStore: session.ledgerStore as NonNullable<typeof session.ledgerStore>, lessonStore: session.lessonStore, modelDriver: session.modelDriver, wirePrefix: session.wirePrefix, humanAdaptersById: session.humanAdaptersById, ctx: session.ctx, executeChildStep: session.executeChildStep }); if (sRes.tournamentFrame.conflictCheckArmed) session.agentFrame = Object.freeze<AgentContinuationFrame>({ ...session.agentFrame, conflictCheckArmed: true }); return Object.freeze({ status: 'completed', content: sRes.toolResultText, isError: sRes.isError }); }
  if ((call.toolName === 'spawnTasks' || call.toolName === 'addDependencies' || call.toolName === 'updatePartitionContract') && session.node.capabilities?.mutatePlan !== undefined) { const pParams = { mutatePlanNode: session.node.capabilities.mutatePlan, laneId: session.laneId ?? 'default-lane', parentItemKey: session.itemKey ?? session.ctx.runId, previouslySpawnedCount: session.spawnedTasksCount, previousSpawnedTipKey: session.previousSpawnedTipKey, tasksToSpawn: (args['tasks'] as readonly SpawnTaskInputEntry[] | undefined) ?? [], dependencyKeysToAdd: (args['prerequisiteItemKeys'] as readonly string[] | undefined) ?? [], contractUpdate: args['partition'] !== undefined ? { partitionId: String(args['partition']), newContractText: String(args['updatedContractText'] ?? '') } : undefined, agentFrame: session.agentFrame, outerFrames: session.outerFrames, pendingToolBatch: batch, ledgerStore: session.ledgerStore as NonNullable<typeof session.ledgerStore>, continuationQueue: session.continuationQueue, topologyStore: session.topologyStore, serviceRegistry: session.serviceRegistry, checkpointScope: scopeDriver, ctx: session.ctx }; if (call.toolName === 'spawnTasks') { const r = await executeSpawnTasks(pParams); session.spawnedTasksCount += r.prerequisiteItemKeys.length; session.previousSpawnedTipKey = r.latestTipItemKey; return Object.freeze({ status: r.suspended ? 'suspended' : 'completed', content: r.toolResultText, isError: false }); } if (call.toolName === 'addDependencies') { const r = await executeAddDependencies(pParams); return Object.freeze({ status: r.suspended ? 'suspended' : 'completed', content: r.toolResultText, isError: false }); } const u = await executeUpdatePartitionContract(pParams); return Object.freeze({ status: 'completed', content: JSON.stringify(u), isError: false }); }
  const escCap = session.node.capabilities?.escalations.find((e) => e.interrupt.id === call.toolName);
  if (escCap !== undefined || call.toolName === 'escalate') { const intrId = escCap?.interrupt.id ?? String(args['interruptId'] ?? 'harness:escalate'), res = await resolveInterruptEdge(session, intrId, args['payload'] ?? args); return res.status === 'resumed' ? Object.freeze({ status: 'completed', content: res.feedback ?? 'Resumed', isError: false }) : Object.freeze({ status: 'interrupted', content: `[Interrupted: ${intrId}]`, isError: true, interruptResolution: res }); }
  return undefined;
}

/**
 * Executes a single tool call through the pre-flight skill lease gate, policy guards, post-flight sandbox or lock lease, and reactive scoped rules (`SPEC.md` §3.4.1–§3.5).
 *
 * Returns the tool result text, error flag, and any interrupt resolution.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>} session - Active agent turn session state.
 * @param {RemainingToolCallRecord}                   call    - Tool call record to execute.
 * @param {PendingToolBatch}                          batch   - Enclosing `PendingToolBatch` state.
 *
 * @returns {Promise<{ readonly status: 'completed' | 'suspended' | 'interrupted'; readonly content: string; readonly isError: boolean; readonly leaseDenied?: boolean; readonly interruptResolution?: InterruptEdgeResolution<THandle> }>} Tool call execution outcome.
 */
export async function executeSingleToolInPipeline<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
  call: RemainingToolCallRecord,
  batch: PendingToolBatch,
): Promise<{ readonly status: 'completed' | 'suspended' | 'interrupted'; readonly content: string; readonly isError: boolean; readonly leaseDenied?: boolean; readonly interruptResolution?: InterruptEdgeResolution<THandle> }> {
  const builtIn = await handleBuiltInSkillAndCapabilityTools(session, call, batch);
  if (builtIn !== undefined) return builtIn;
  const requiredSkillId = session.skillOwnerByToolName.get(call.toolName);
  if (requiredSkillId !== undefined && !session.agentFrame.activeSkillIds.includes(requiredSkillId)) return Object.freeze({ status: 'completed', content: `Tool '${call.toolName}' requires active skill '${requiredSkillId}' via activateSkill.`, isError: true });
  const toolNode = session.toolsByName.get(call.toolName) as ToolASTNode<THandle> | undefined, toolDriver = toolNode !== undefined ? session.ctx.registry.tools[toolNode.type] : undefined;
  if (toolNode === undefined || toolDriver === undefined) return Object.freeze({ status: 'completed', content: `Unregistered tool '${call.toolName}' on agent '${session.node.id}'.`, isError: true });
  const validatedArgs = toolNode.inputSchema.parse(JSON.parse(call.argsJson || '{}'));
  if (toolNode.effectTracking === 'declared') {
    const preEval = await evaluatePreFlightToolBatch({ policy: session.node.policy, remainingCalls: [call], toolsByName: session.toolsByName, activeLeases: session.agentFrame.activeLeases, ctx: session.ctx });
    if (preEval.status === 'denied-with-error') return Object.freeze({ status: 'completed', content: preEval.deniedErrorMessage ?? 'Denied', isError: true });
    if (preEval.status === 'raise-interrupt' && preEval.raisedInterrupt !== undefined) {
      if (call.blockedPreFlight === true && batch.adjudicationFeedback !== undefined) return Object.freeze({ status: 'completed', content: `[Lease Denied: ${batch.adjudicationFeedback}]`, isError: true, leaseDenied: true });
      const intrRes = await resolveInterruptEdge(session, preEval.raisedInterrupt.id, preEval.interruptPayload);
      if (intrRes.status !== 'resumed') return Object.freeze({ status: 'interrupted', content: `[Interrupted: ${preEval.raisedInterrupt.id}]`, isError: true, interruptResolution: intrRes });
      const reEval = await evaluatePreFlightToolBatch({ policy: session.node.policy, remainingCalls: [call], toolsByName: session.toolsByName, activeLeases: session.agentFrame.activeLeases, ctx: session.ctx }, preEval.primaryEffects);
      if (reEval.status !== 'allowed') return Object.freeze({ status: 'completed', content: `[Lease Denied: ${intrRes.feedback ?? ''}]`, isError: true, leaseDenied: true });
    }
    const mutates = preEval.primaryEffects.some((e) => e.mutatesScope === true);
    const rawOut = mutates ? await session.lockManager.withWriteLock(session.ctx.scopeHandle, () => Promise.resolve(toolDriver.execute(toolNode as never, validatedArgs as never, session.ctx as never))) : await session.lockManager.withReadLock(session.ctx.scopeHandle, () => Promise.resolve(toolDriver.execute(toolNode as never, validatedArgs as never, session.ctx as never)));
    const outStr = typeof rawOut === 'string' ? rawOut : JSON.stringify(rawOut);
    return Object.freeze({ status: 'completed', content: await applyReactiveScopedRulesAndRecordEffects(session, preEval.primaryEffects, outStr), isError: false });
  }
  const scopeFactory = session.ctx.scopeNode !== undefined ? session.ctx.registry.scopes[session.ctx.scopeNode.type] : undefined;
  const scopeDriver = (scopeFactory !== undefined && session.ctx.scopeNode !== undefined ? scopeFactory(session.ctx.scopeNode as never, { registry: session.ctx.registry, resolveEnv: (v) => (typeof v === 'string' ? v : undefined), getRunner: (n) => { const f = session.ctx.registry.runners[n.type]; if (f === undefined) throw new Error(n.type); return f(n as never); } }) : undefined) as CheckpointableScope<THandle> | undefined;
  if (scopeDriver !== undefined) {
    const sbOut = await executePostFlightSandboxedTool({ toolNode, toolDriver: toolDriver as never, parsedArgs: validatedArgs, callRecord: call, policy: session.node.policy, activeLeases: session.agentFrame.activeLeases, checkpointScope: scopeDriver, ctx: session.ctx, persistInFlightCheckpoint: async (ckpt) => { session.agentFrame = Object.freeze<AgentContinuationFrame>({ ...session.agentFrame, pauseState: Object.freeze({ kind: 'tool-batch', pendingToolBatch: batch, inFlightPreToolCheckpoint: ckpt }) }); if (session.ledgerStore !== undefined) { const stack: readonly ContinuationFrame[] = Object.freeze([...session.outerFrames, session.agentFrame]); await session.continuationQueue.enqueueUpdate(session.ctx.stepExecId, () => (session.ledgerStore as NonNullable<typeof session.ledgerStore>).updateContinuationStack(session.ctx.runId, session.ctx.stepExecId, stack)); } } });
    if (sbOut.status !== 'allowed') {
      if (sbOut.status === 'rolled-back-interrupt' && sbOut.policyResult?.raisedInterrupt !== undefined) { const intrRes = await resolveInterruptEdge(session, sbOut.policyResult.raisedInterrupt.id, sbOut.policyResult.interruptPayload); if (intrRes.status !== 'resumed') return Object.freeze({ status: 'interrupted', content: sbOut.toolResult.content, isError: true, interruptResolution: intrRes }); }
      return Object.freeze({ status: 'completed', content: sbOut.toolResult.content, isError: true });
    }
    return Object.freeze({ status: 'completed', content: await applyReactiveScopedRulesAndRecordEffects(session, sbOut.synthesizedEffects, sbOut.toolResult.content), isError: Boolean(sbOut.toolResult.isError) });
  }
  const rawOut = await session.lockManager.withWriteLock(session.ctx.scopeHandle, () => Promise.resolve(toolDriver.execute(toolNode as never, validatedArgs as never, session.ctx as never)));
  return Object.freeze({ status: 'completed', content: typeof rawOut === 'string' ? rawOut : JSON.stringify(rawOut), isError: false });
}

/**
 * Drains `PendingToolBatch.remainingCalls` in strict `(1..k)` declaration order and writes a single `role: 'tool'` wire frame (`SPEC.md` §3.5 & §3.7.2).
 *
 * Handles pre-flight batching across `'raise-interrupt'` clauses, `[SERVICE_REACQUIRED]` notes, `[Lease Elevated]` / `[Lease Denied]` prefixes, and dependent call skipping.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>} session      - Active agent turn session state.
 * @param {PendingToolBatch}                          initialBatch - Initial or resumed `PendingToolBatch` state.
 *
 * @returns {Promise<DrainToolBatchOutcome<THandle>>} Final drain outcome (`'completed'`, `'suspended'`, or `'interrupted'`).
 */
export async function drainPendingToolBatch<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
  initialBatch: PendingToolBatch,
): Promise<DrainToolBatchOutcome<THandle>> {
  const reacquiredNotes = await session.serviceRegistry.reacquireActiveSkillServices({ runId: session.ctx.runId, scopeKey: session.ctx.stepExecId, scopeHandle: session.ctx.scopeHandle, activeSkillIds: session.agentFrame.activeSkillIds, skillsById: session.skillsById, driverContext: { registry: session.ctx.registry, resolveEnv: (v) => (typeof v === 'string' ? v : undefined), getRunner: (n) => { const f = session.ctx.registry.runners[n.type]; if (f === undefined) throw new Error(n.type); return f(n as never); } } });
  let batch = initialBatch, precedingReplayCallDenied = false;
  while (batch.remainingCalls.length > 0) {
    const call = batch.remainingCalls[0] as RemainingToolCallRecord;
    if (precedingReplayCallDenied) {
      batch = Object.freeze<PendingToolBatch>({ ...batch, completedResults: Object.freeze([...batch.completedResults, Object.freeze({ callId: call.callId, content: '[Skipped: Preceding tool call in turn batch was denied]', isError: true })]), remainingCalls: Object.freeze(batch.remainingCalls.slice(1)) });
      continue;
    }
    const stepOut = await executeSingleToolInPipeline(session, call, batch);
    if (stepOut.status === 'interrupted') {
      session.agentFrame = Object.freeze<AgentContinuationFrame>({ ...session.agentFrame, pauseState: Object.freeze({ kind: 'tool-batch', pendingToolBatch: batch }) });
      return Object.freeze<DrainToolBatchOutcome<THandle>>({ status: 'interrupted', batch, interruptResolution: stepOut.interruptResolution });
    }
    if (stepOut.leaseDenied === true) precedingReplayCallDenied = true;
    const prefix = call.blockedPreFlight === true && batch.adjudicationFeedback !== undefined && stepOut.leaseDenied !== true ? `[Lease Elevated: ${batch.adjudicationFeedback}]\n\n` : '';
    const svcPrefix = batch.completedResults.length === 0 && reacquiredNotes.length > 0 ? `${reacquiredNotes.join('\n')}\n` : '';
    batch = Object.freeze<PendingToolBatch>({ ...batch, completedResults: Object.freeze([...batch.completedResults, Object.freeze({ callId: call.callId, content: `${svcPrefix}${prefix}${stepOut.content}`, isError: stepOut.isError })]), remainingCalls: Object.freeze(batch.remainingCalls.slice(1)) });
    if (stepOut.status === 'suspended') return Object.freeze<DrainToolBatchOutcome<THandle>>({ status: 'suspended', batch });
    session.agentFrame = Object.freeze<AgentContinuationFrame>({ ...session.agentFrame, pauseState: Object.freeze({ kind: 'tool-batch', pendingToolBatch: batch }) });
    if (session.ledgerStore !== undefined) {
      const stack: readonly ContinuationFrame[] = Object.freeze([...session.outerFrames, session.agentFrame]);
      await session.continuationQueue.enqueueUpdate(session.ctx.stepExecId, () => (session.ledgerStore as NonNullable<typeof session.ledgerStore>).updateContinuationStack(session.ctx.runId, session.ctx.stepExecId, stack));
    }
  }
  if (session.ledgerStore !== undefined && batch.completedResults.length > 0) {
    const toolMsgId = `msg:${session.ctx.stepExecId}:tools:${String(session.agentFrame.turnsTaken)}`, frameJson = JSON.stringify(batch.completedResults);
    const canonicalResults = batch.completedResults.map((r) => Object.freeze({ callId: r.callId, content: r.content, isError: Boolean(r.isError) }));
    await session.ledgerStore.appendMessageFrame(session.ctx.runId, Object.freeze<WireFrameRecord>({ messageId: toolMsgId, parentMessageId: session.agentFrame.leafMessageId, vendorId: session.modelNode.vendor, rawWireFrame: new TextEncoder().encode(frameJson), canonical: Object.freeze({ role: 'tool', visibleText: frameJson, toolResults: Object.freeze(canonicalResults) }), prefixDigest: session.wirePrefix?.systemDigest ?? 'unpinned' }));
    session.agentFrame = Object.freeze<AgentContinuationFrame>({ ...session.agentFrame, leafMessageId: toolMsgId, pausedAtPhase: 'TOOL_BOUNDARY', pauseState: Object.freeze({ kind: 'active-turn' }) });
  }
  return Object.freeze<DrainToolBatchOutcome<THandle>>({ status: 'completed', batch });
}
