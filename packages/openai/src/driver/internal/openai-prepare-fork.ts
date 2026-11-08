import type { ForkContext, PrepareForkTarget, WireFrameRecord } from '@paraharness/core';
import { buildOpenAiPairedForkToolFrame } from './build-openai-paired-fork-tool-frame.js';
import { buildOpenAiUserFrame } from './build-openai-user-frame.js';
import { formatOpenAiForkPromptText } from './format-openai-fork-prompt-text.js';
import { sliceOpenAiParentChain } from './slice-openai-parent-chain.js';
import { transformOpenAiForkFrame } from './transform-openai-fork-frame.js';

/**
 * Synthesizes the initial `WireFrameRecord[]` chain for an OpenAI downward fork or cross-model escalation.
 *
 * Handles `'shared-prefix-only'` clean starts, `'clone-transcript'` with `previous_response_id` preservation
 * vs stripping on `substituteTombstones: true` / cross-seat failover, and full-turn `(1..k)` `function_call_output` pairing.
 *
 * @param {ForkContext}       ctx    - Fork lineage, history mode, and assistant turn-batch metadata.
 * @param {PrepareForkTarget} target - Target model configuration and `substituteTombstones` flag.
 *
 * @returns {readonly WireFrameRecord[]} Synthesized wire frame chain to persist in `LedgerStore`.
 */
export function openaiPrepareFork(
  ctx: ForkContext,
  target: PrepareForkTarget,
): readonly WireFrameRecord[] {
  const combinedPrompt = formatOpenAiForkPromptText(ctx);
  if (ctx.historyMode === 'shared-prefix-only') {
    if (combinedPrompt.length === 0) {
      return Object.freeze([]);
    }
    return Object.freeze([
      buildOpenAiUserFrame({
        messageId: `msg:fork:${target.modelId}:turn-0`,
        parentMessageId: null,
        text: combinedPrompt,
      }),
    ]);
  }
  const sliced = sliceOpenAiParentChain(ctx);
  const frames: WireFrameRecord[] = [];
  for (let idx = 0; idx < sliced.length; idx += 1) {
    const sourceFrame = sliced[idx];
    if (sourceFrame !== undefined) {
      frames.push(
        transformOpenAiForkFrame({
          frame: sourceFrame,
          target,
          isForkPoint: idx === sliced.length - 1,
        }),
      );
    }
  }
  const lastFrame = frames[frames.length - 1];
  if (
    lastFrame !== undefined &&
    (lastFrame.canonical.toolCalls?.length ?? 0) > 0 &&
    ctx.forkCallId !== undefined
  ) {
    frames.push(buildOpenAiPairedForkToolFrame(ctx, lastFrame));
  } else if (
    ctx.childRoleContextFrameText !== undefined &&
    ctx.childRoleContextFrameText.length > 0
  ) {
    frames.push(
      buildOpenAiUserFrame({
        messageId: `${lastFrame?.messageId ?? 'root'}:fork-context`,
        parentMessageId: lastFrame?.messageId ?? null,
        text: combinedPrompt,
      }),
    );
  }
  return Object.freeze(frames);
}
