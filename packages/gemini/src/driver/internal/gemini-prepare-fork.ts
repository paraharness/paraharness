import type { ForkContext, PrepareForkTarget, WireFrameRecord } from '@harness-dsl/core';
import { buildGeminiPairedForkToolFrame } from './build-gemini-paired-fork-tool-frame.js';
import { buildGeminiUserFrame } from './build-gemini-user-frame.js';
import { formatGeminiForkPromptText } from './format-gemini-fork-prompt-text.js';
import { sliceGeminiParentChain } from './slice-gemini-parent-chain.js';
import { transformGeminiForkFrame } from './transform-gemini-fork-frame.js';

/**
 * Synthesizes the initial `WireFrameRecord[]` chain for a Google Gemini downward fork or cross-model escalation.
 *
 * Preserves `thought: true` and `thoughtSignature` fields when `target.substituteTombstones === false`,
 * strips them when `target.substituteTombstones === true`, and pairs all `1..k` `functionResponse` parts on assistant tool forks.
 *
 * @param {ForkContext}       ctx    - Fork lineage, history mode, and assistant turn-batch metadata.
 * @param {PrepareForkTarget} target - Target model configuration and `substituteTombstones` flag.
 *
 * @returns {readonly WireFrameRecord[]} Synthesized wire frame chain to persist in `LedgerStore`.
 */
export function geminiPrepareFork(
  ctx: ForkContext,
  target: PrepareForkTarget,
): readonly WireFrameRecord[] {
  const combinedPrompt = formatGeminiForkPromptText(ctx);
  if (ctx.historyMode === 'shared-prefix-only') {
    if (combinedPrompt.length === 0) {
      return Object.freeze([]);
    }
    return Object.freeze([
      buildGeminiUserFrame({
        messageId: `msg:fork:${target.modelId}:turn-0`,
        parentMessageId: null,
        text: combinedPrompt,
      }),
    ]);
  }
  const sliced = sliceGeminiParentChain(ctx);
  const toolNameByCallId = new Map<string, string>();
  for (const frame of sliced) {
    for (const call of frame.canonical.toolCalls ?? []) {
      toolNameByCallId.set(call.id, call.name);
    }
  }
  const frames: WireFrameRecord[] = [];
  for (const sourceFrame of sliced) {
    frames.push(
      transformGeminiForkFrame({
        frame: sourceFrame,
        substituteTombstones: target.substituteTombstones,
        toolNameByCallId,
      }),
    );
  }
  const lastFrame = frames[frames.length - 1];
  if (
    lastFrame !== undefined &&
    (lastFrame.canonical.toolCalls?.length ?? 0) > 0 &&
    ctx.forkCallId !== undefined
  ) {
    frames.push(buildGeminiPairedForkToolFrame(ctx, lastFrame));
  } else if (
    ctx.childRoleContextFrameText !== undefined &&
    ctx.childRoleContextFrameText.length > 0
  ) {
    frames.push(
      buildGeminiUserFrame({
        messageId: `${lastFrame?.messageId ?? 'root'}:fork-context`,
        parentMessageId: lastFrame?.messageId ?? null,
        text: combinedPrompt,
      }),
    );
  }
  return Object.freeze(frames);
}
