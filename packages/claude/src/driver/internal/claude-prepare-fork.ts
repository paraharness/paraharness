import type { ForkContext, PrepareForkTarget, WireFrameRecord } from '@paraharness/core';
import { buildClaudePairedForkToolFrame } from './build-claude-paired-fork-tool-frame.js';
import { buildClaudeUserFrame } from './build-claude-user-frame.js';
import { formatClaudeForkPromptText } from './format-claude-fork-prompt-text.js';
import { sliceClaudeParentChain } from './slice-claude-parent-chain.js';
import { transformClaudeForkFrame } from './transform-claude-fork-frame.js';

/**
 * Synthesizes the initial `WireFrameRecord[]` chain for an Anthropic downward fork or cross-model escalation.
 *
 * Handles `'shared-prefix-only'` clean starts, `'clone-transcript'` with `substituteTombstones` (`false` vs `true`),
 * and full-turn `(1..k)` `tool_result` pairing whenever `ctx.forkCallId` is set on an assistant tool-call turn.
 *
 * @param {ForkContext}       ctx    - Fork lineage, history mode, and assistant turn-batch metadata.
 * @param {PrepareForkTarget} target - Target model configuration and `substituteTombstones` flag.
 *
 * @returns {readonly WireFrameRecord[]} Synthesized wire frame chain to persist in `LedgerStore`.
 */
export function claudePrepareFork(
  ctx: ForkContext,
  target: PrepareForkTarget,
): readonly WireFrameRecord[] {
  const combinedPrompt = formatClaudeForkPromptText(ctx);
  if (ctx.historyMode === 'shared-prefix-only') {
    if (combinedPrompt.length === 0) {
      return Object.freeze([]);
    }
    return Object.freeze([
      buildClaudeUserFrame({
        messageId: `msg:fork:${target.modelId}:turn-0`,
        parentMessageId: null,
        text: combinedPrompt,
      }),
    ]);
  }
  const sliced = sliceClaudeParentChain(ctx);
  const frames: WireFrameRecord[] = [];
  for (let idx = 0; idx < sliced.length; idx += 1) {
    const sourceFrame = sliced[idx];
    if (sourceFrame !== undefined) {
      frames.push(
        transformClaudeForkFrame({
          frame: sourceFrame,
          substituteTombstones: target.substituteTombstones,
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
    frames.push(buildClaudePairedForkToolFrame(ctx, lastFrame));
  } else if (
    ctx.childRoleContextFrameText !== undefined &&
    ctx.childRoleContextFrameText.length > 0
  ) {
    frames.push(
      buildClaudeUserFrame({
        messageId: `${lastFrame?.messageId ?? 'root'}:fork-context`,
        parentMessageId: lastFrame?.messageId ?? null,
        text: combinedPrompt,
      }),
    );
  }
  return Object.freeze(frames);
}
