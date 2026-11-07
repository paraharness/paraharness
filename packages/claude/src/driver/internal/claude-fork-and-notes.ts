import type {
  AppendToolResultNotesOptions,
  CanonicalMessage,
  CanonicalToolResult,
  ForkContext,
  PrepareForkTarget,
  WireFrameRecord,
} from '@harness-dsl/core';
import {
  buildClaudePairedForkToolFrame,
  buildClaudeUserFrame,
  sliceClaudeParentChain,
  transformClaudeForkFrame,
} from './claude-fork-helpers.js';
import { projectCanonicalToAnthropicMessage } from './claude-wire-converter.js';

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
export function prepareClaudeForkFrames(
  ctx: ForkContext,
  target: PrepareForkTarget,
): readonly WireFrameRecord[] {
  const promptParts: string[] = [];
  if (ctx.childRoleContextFrameText !== undefined && ctx.childRoleContextFrameText.length > 0) {
    promptParts.push(ctx.childRoleContextFrameText);
  }
  if (ctx.childTaskPromptText !== undefined && ctx.childTaskPromptText.length > 0) {
    promptParts.push(ctx.childTaskPromptText);
  }
  if (ctx.historyMode === 'shared-prefix-only') {
    if (promptParts.length === 0) {
      return Object.freeze([]);
    }
    return Object.freeze([buildClaudeUserFrame(`msg:fork:${target.modelId}:turn-0`, null, promptParts.join('\n\n'))]);
  }
  const sliced = sliceClaudeParentChain(ctx);
  const frames: WireFrameRecord[] = [];
  for (let idx = 0; idx < sliced.length; idx += 1) {
    const sourceFrame = sliced[idx];
    if (sourceFrame !== undefined) {
      frames.push(transformClaudeForkFrame(sourceFrame, target.substituteTombstones, idx === sliced.length - 1));
    }
  }
  const lastFrame = frames[frames.length - 1];
  if (lastFrame !== undefined && (lastFrame.canonical.toolCalls?.length ?? 0) > 0 && ctx.forkCallId !== undefined) {
    frames.push(buildClaudePairedForkToolFrame(ctx, lastFrame));
  } else if (ctx.childRoleContextFrameText !== undefined && ctx.childRoleContextFrameText.length > 0) {
    frames.push(buildClaudeUserFrame(`${lastFrame?.messageId ?? 'root'}:fork-context`, lastFrame?.messageId ?? null, promptParts.join('\n\n')));
  }
  return Object.freeze(frames);
}

/**
 * Appends synchronization or recovery notes in-place to an Anthropic `tool` or `user` `WireFrameRecord`.
 *
 * Updates both `frame.canonical` and `frame.rawWireFrame`, targeting `targetCallId` (or the last
 * `tool_result` block) on `role: 'tool'` frames and setting `is_error: true` when `opts?.isError === true`.
 *
 * @param {WireFrameRecord}                          frame        - Existing `tool` or `user` wire frame record.
 * @param {readonly string[]}                        notes        - Synchronization note strings to append.
 * @param {string | undefined}                       targetCallId - Optional tool `callId` to target on a `tool` frame.
 * @param {AppendToolResultNotesOptions | undefined} opts         - Optional error status override.
 *
 * @returns {WireFrameRecord} Updated wire frame record with appended notes.
 */
export function appendClaudeToolResultNotes(
  frame: WireFrameRecord,
  notes: readonly string[],
  targetCallId?: string,
  opts?: AppendToolResultNotesOptions,
): WireFrameRecord {
  if (notes.length === 0) {
    return frame;
  }
  const suffix = notes.join('\n');
  if (frame.canonical.role === 'tool' && frame.canonical.toolResults !== undefined) {
    const results = frame.canonical.toolResults;
    let targetIdx = results.length - 1;
    if (targetCallId !== undefined) {
      for (let idx = 0; idx < results.length; idx += 1) {
        if (results[idx]?.callId === targetCallId) {
          targetIdx = idx;
          break;
        }
      }
    }
    const updatedResults: CanonicalToolResult[] = [];
    for (let idx = 0; idx < results.length; idx += 1) {
      const item = results[idx];
      if (item !== undefined) {
        const nextContent = idx === targetIdx ? (item.content.length > 0 ? `${item.content}\n${suffix}` : suffix) : item.content;
        const nextError = idx === targetIdx && opts?.isError !== undefined ? opts.isError : item.isError;
        updatedResults.push(Object.freeze({ callId: item.callId, content: nextContent, isError: nextError }));
      }
    }
    const canonical = Object.freeze<CanonicalMessage>({ ...frame.canonical, toolResults: Object.freeze(updatedResults) });
    const rawWireFrame = new TextEncoder().encode(JSON.stringify(projectCanonicalToAnthropicMessage(canonical)));
    return Object.freeze<WireFrameRecord>({ ...frame, rawWireFrame, canonical });
  }
  const nextText = frame.canonical.visibleText.length > 0 ? `${frame.canonical.visibleText}\n${suffix}` : suffix;
  const canonical = Object.freeze<CanonicalMessage>({ ...frame.canonical, role: 'user', visibleText: nextText });
  const rawWireFrame = new TextEncoder().encode(JSON.stringify(projectCanonicalToAnthropicMessage(canonical)));
  return Object.freeze<WireFrameRecord>({ ...frame, rawWireFrame, canonical });
}
