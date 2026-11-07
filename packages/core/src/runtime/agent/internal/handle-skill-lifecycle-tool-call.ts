import type { AgentContinuationFrame } from '../../../ports/agent-continuation-frame.js';
import type { LoopContinuationFrame } from '../../../ports/loop-continuation-frame.js';
import type { RemainingToolCallRecord } from '../../../ports/pending-tool-batch.js';
import type { RuntimeDriverContext } from '../../../ports/runtime-driver-context.js';
import type { AgentTurnSessionState } from '../agent-turn-session-state.js';

/**
 * Handles a built-in `activateSkill` tool call (`SPEC.md` §3.4.2).
 *
 * Acquires reference-counted `ServiceSession` daemons for the skill, adds `skillId` to `activeSkillIds`,
 * records the activation coordinate in `activeSkillActivations`, and returns `[SKILL_ACTIVATED: <skillId>]`.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>} session - Active agent turn session state.
 * @param {RemainingToolCallRecord}                   call    - `activateSkill` tool call record.
 * @param {RuntimeDriverContext}                      drvCtx  - Runtime driver context for service acquisition.
 *
 * @returns {Promise<{ readonly status: 'completed'; readonly content: string; readonly isError: boolean }>} `activateSkill` tool call result.
 */
export async function handleActivateSkillToolCall<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
  call: RemainingToolCallRecord,
  drvCtx: RuntimeDriverContext,
): Promise<{ readonly status: 'completed'; readonly content: string; readonly isError: boolean }> {
  const args = JSON.parse(call.argsJson || '{}') as Record<string, unknown>;
  const skillId = String(args['skillId'] ?? args['id'] ?? '');
  const skill = session.skillsById.get(skillId);
  if (skill === undefined) {
    return Object.freeze({
      status: 'completed',
      content: `Unknown skill '${skillId}'.`,
      isError: true,
    });
  }
  await session.serviceRegistry.acquireSkillServices({
    runId: session.ctx.runId,
    scopeKey: session.ctx.stepExecId,
    scopeHandle: session.ctx.scopeHandle,
    skill,
    driverContext: drvCtx,
  });
  const activeIds = new Set(session.agentFrame.activeSkillIds).has(skillId)
    ? session.agentFrame.activeSkillIds
    : Object.freeze([...session.agentFrame.activeSkillIds, skillId]);
  const activations = Object.freeze({
    ...session.agentFrame.activeSkillActivations,
    [skillId]: Object.freeze({
      messageId: session.agentFrame.leafMessageId ?? 'turn-0',
      callId: call.callId,
    }),
  });
  session.agentFrame = Object.freeze<AgentContinuationFrame>({
    ...session.agentFrame,
    activeSkillIds: activeIds,
    activeSkillActivations: activations,
  });
  for (let idx = 0; idx < session.outerFrames.length; idx += 1) {
    const outer = session.outerFrames[idx];
    if (outer?.kind === 'loop-frame' && outer.phase === 'act') {
      session.outerFrames[idx] = Object.freeze<LoopContinuationFrame>({
        ...outer,
        activeSkillIds: activeIds,
        activeSkillActivations: activations,
      });
    }
  }
  const instrText =
    typeof skill.instructions === 'string'
      ? skill.instructions
      : JSON.stringify(skill.instructions);
  return Object.freeze({
    status: 'completed',
    content: `[SKILL_ACTIVATED: ${skillId}]\n${instrText}`,
    isError: false,
  });
}

/**
 * Handles a built-in `completeSkill` tool call (`SPEC.md` §3.4.2).
 *
 * Releases reference-counted `ServiceSession` daemons for `skillId`, records a compaction tombstone
 * in `LedgerStore` (defaulting to `"[Skill '<skillId>' completed and unmounted]"` when `summary` is omitted),
 * and unmounts `skillId` from `activeSkillIds`.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>} session - Active agent turn session state.
 * @param {RemainingToolCallRecord}                   call    - `completeSkill` tool call record.
 *
 * @returns {Promise<{ readonly status: 'completed'; readonly content: string; readonly isError: boolean }>} `completeSkill` tool call result.
 */
export async function handleCompleteSkillToolCall<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
  call: RemainingToolCallRecord,
): Promise<{ readonly status: 'completed'; readonly content: string; readonly isError: boolean }> {
  const args = JSON.parse(call.argsJson || '{}') as Record<string, unknown>;
  const skillId = String(args['skillId'] ?? args['id'] ?? '');
  const rawSummary = typeof args['summary'] === 'string' ? args['summary'] : '';
  const summary =
    rawSummary.length > 0 ? rawSummary : `[Skill '${skillId}' completed and unmounted]`;
  const actCoord = session.agentFrame.activeSkillActivations[skillId];
  await session.serviceRegistry.releaseSkillServices(session.ctx.stepExecId, skillId);
  if (actCoord !== undefined && session.ledgerStore !== undefined) {
    await session.ledgerStore.markFrameTombstone(
      session.ctx.runId,
      actCoord.messageId,
      actCoord.callId,
      summary,
    );
  }
  const nextActs: Record<string, { readonly messageId: string; readonly callId: string }> = {};
  const nextActiveList: string[] = [];
  for (const id of session.agentFrame.activeSkillIds) {
    if (id === skillId) {
      continue;
    }
    nextActiveList.push(id);
    const act = session.agentFrame.activeSkillActivations[id];
    if (act !== undefined) {
      nextActs[id] = act;
    }
  }
  const nextActiveIds = Object.freeze(nextActiveList);
  const frozenActs = Object.freeze(nextActs);
  session.agentFrame = Object.freeze<AgentContinuationFrame>({
    ...session.agentFrame,
    activeSkillIds: nextActiveIds,
    activeSkillActivations: frozenActs,
  });
  for (let idx = 0; idx < session.outerFrames.length; idx += 1) {
    const outer = session.outerFrames[idx];
    if (outer?.kind === 'loop-frame' && outer.phase === 'act') {
      session.outerFrames[idx] = Object.freeze<LoopContinuationFrame>({
        ...outer,
        activeSkillIds: nextActiveIds,
        activeSkillActivations: frozenActs,
      });
    }
  }
  return Object.freeze({
    status: 'completed',
    content: `[SKILL_COMPLETED: ${skillId}] ${summary}`,
    isError: false,
  });
}

/**
 * Dispatches built-in `activateSkill` and `completeSkill` lifecycle tool calls (`SPEC.md` §3.4.2).
 *
 * Returns `undefined` when `call.toolName` is not a skill lifecycle tool.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>} session - Active agent turn session state.
 * @param {RemainingToolCallRecord}                   call    - Tool call record being dispatched.
 * @param {RuntimeDriverContext}                      drvCtx  - Runtime driver context.
 *
 * @returns {Promise<{ readonly status: 'completed'; readonly content: string; readonly isError: boolean } | undefined>} Skill tool outcome, or `undefined`.
 */
export async function handleSkillLifecycleToolCall<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
  call: RemainingToolCallRecord,
  drvCtx: RuntimeDriverContext,
): Promise<
  | { readonly status: 'completed'; readonly content: string; readonly isError: boolean }
  | undefined
> {
  if (call.toolName === 'activateSkill') {
    return handleActivateSkillToolCall(session, call, drvCtx);
  }
  if (call.toolName === 'completeSkill') {
    return handleCompleteSkillToolCall(session, call);
  }
  return undefined;
}
