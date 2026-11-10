import type { LoopContinuationFrame } from '../../../ports/loop-continuation-frame.js';
import type { WireFrameRecord } from '../../../ports/wire-frame-record.js';
import type { LoopExecutionState } from '../loop-execution-state.js';

/**
 * Escalates the `.act()` actor's model on retry iterations and migrates the preserved transcript via `ModelDriver.prepareFork` (`SPEC.md` §3.8).
 *
 * Substitutes tombstones (`substituteTombstones: true`) and remaps `activeSkillActivations` `messageId` coordinates when switching models.
 *
 * @template TIn     Validated loop input payload type.
 * @template TOut    Validated loop output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {LoopExecutionState<TIn, TOut, THandle>} state - Active loop execution state.
 *
 * @returns {Promise<void>} Resolves once model selection and any cross-model transcript fork are complete.
 */
export async function escalateLoopActorModelIfNeeded<TIn, TOut, THandle>(
  state: LoopExecutionState<TIn, TOut, THandle>,
): Promise<void> {
  if (state.loopFrame.iteration === 0) {
    return;
  }
  const nextModel = state.poolManager.selectModel(
    state.node.actStep.actor.model,
    state.ctx.runId,
    state.loopFrame.iteration,
  );
  if (nextModel.modelId === state.currentActModelNode.modelId) {
    return;
  }
  state.currentActModelNode = nextModel;
  if (
    !state.node.preserveActorSession ||
    state.loopFrame.preservedActLeafMessageId === null ||
    state.ledgerStore === undefined
  ) {
    state.loopFrame = Object.freeze<LoopContinuationFrame>({
      ...state.loopFrame,
      lastActModelId: nextModel.modelId,
    });
    return;
  }
  const nextDriverFactory = state.ctx.registry.models[nextModel.type];
  if (nextDriverFactory === undefined) {
    throw new Error(`No ModelDriver for '${nextModel.type}' during loop escalation.`);
  }
  const nextDriver = nextDriverFactory(nextModel as never, {
    registry: state.ctx.registry,
    resolveEnv: (v) => state.ctx.resolveEnv(v),
    getRunner: (n) => state.ctx.getRunner(n),
  });
  const sourceHistory = await state.ledgerStore.getMessageChain(
    state.loopFrame.preservedActLeafMessageId,
  );
  const forkedHistory = await nextDriver.prepareFork(
    {
      historyMode: 'clone-transcript',
      parentChain: sourceHistory,
      forkPointMessageId: state.loopFrame.preservedActLeafMessageId,
    },
    {
      modelId: nextModel.modelId,
      effort: nextModel.effort,
      substituteTombstones: true,
    },
  );
  const msgIdMap = new Map<string, string>();
  let newLeafId = state.loopFrame.preservedActLeafMessageId;
  for (let idx = 0; idx < forkedHistory.length; idx += 1) {
    const oldFrame = sourceHistory[idx];
    const rawFrame = forkedHistory[idx] as WireFrameRecord;
    const finalMsgId =
      oldFrame !== undefined && rawFrame.messageId === oldFrame.messageId
        ? `${rawFrame.messageId}:escalated:${String(state.loopFrame.iteration)}`
        : rawFrame.messageId;
    const remappedParentId =
      rawFrame.parentMessageId !== null
        ? (msgIdMap.get(rawFrame.parentMessageId) ?? rawFrame.parentMessageId)
        : null;
    if (oldFrame !== undefined) {
      msgIdMap.set(oldFrame.messageId, finalMsgId);
    }
    const newFrame =
      finalMsgId === rawFrame.messageId && remappedParentId === rawFrame.parentMessageId
        ? rawFrame
        : Object.freeze<WireFrameRecord>({
            ...rawFrame,
            messageId: finalMsgId,
            parentMessageId: remappedParentId,
          });
    await state.ledgerStore.appendMessageFrame(state.ctx.runId, newFrame);
    newLeafId = newFrame.messageId;
  }
  const remappedActivations: Record<
    string,
    { readonly messageId: string; readonly callId: string }
  > = {};
  for (const skillId in state.loopFrame.activeSkillActivations) {
    if (!Object.hasOwn(state.loopFrame.activeSkillActivations, skillId)) {
      continue;
    }
    const coord = state.loopFrame.activeSkillActivations[skillId];
    if (coord === undefined) {
      continue;
    }
    remappedActivations[skillId] = Object.freeze({
      messageId: msgIdMap.get(coord.messageId) ?? coord.messageId,
      callId: coord.callId,
    });
  }
  state.loopFrame = Object.freeze<LoopContinuationFrame>({
    ...state.loopFrame,
    lastActModelId: nextModel.modelId,
    preservedActLeafMessageId: newLeafId,
    activeSkillActivations: Object.freeze(remappedActivations),
  });
}
