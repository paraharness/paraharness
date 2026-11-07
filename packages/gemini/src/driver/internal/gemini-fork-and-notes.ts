import type {
  AppendToolResultNotesOptions,
  CanonicalMessage,
  CanonicalToolResult,
  ForkContext,
  PrepareForkTarget,
  WireFrameRecord,
} from '@harness-dsl/core';
import {
  buildGeminiPairedForkToolFrame,
  buildGeminiUserFrame,
  sliceGeminiParentChain,
  transformGeminiForkFrame,
} from './gemini-fork-helpers.js';
import {
  projectCanonicalToGeminiContent,
  tryDecodeGeminiWireContent,
} from './gemini-wire-helpers.js';

/**
 * Extracts `functionResponse.id -> functionResponse.name` mappings from an existing Gemini `rawWireFrame`.
 *
 * Preserves original tool names when `appendGeminiToolResultNotes` re-projects a `role: 'tool'` frame.
 *
 * @param {Uint8Array} rawWireFrame - Raw wire frame bytes from an existing `WireFrameRecord`.
 *
 * @returns {ReadonlyMap<string, string>} Map from tool `callId` to tool `name`.
 */
function extractGeminiToolNamesFromWire(rawWireFrame: Uint8Array): ReadonlyMap<string, string> {
  const toolNameByCallId = new Map<string, string>();
  const decoded = tryDecodeGeminiWireContent(rawWireFrame);
  const rawParts = (decoded?.['parts'] as readonly Readonly<Record<string, unknown>>[]) ?? [];
  for (const part of rawParts) {
    const fr = part['functionResponse'] as Readonly<Record<string, unknown>> | undefined;
    if (fr !== undefined && typeof fr['id'] === 'string' && typeof fr['name'] === 'string') {
      toolNameByCallId.set(fr['id'], fr['name']);
    }
  }
  return toolNameByCallId;
}

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
export function prepareGeminiForkFrames(
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
    return Object.freeze([buildGeminiUserFrame(`msg:fork:${target.modelId}:turn-0`, null, promptParts.join('\n\n'))]);
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
    frames.push(transformGeminiForkFrame(sourceFrame, target.substituteTombstones, toolNameByCallId));
  }
  const lastFrame = frames[frames.length - 1];
  if (lastFrame !== undefined && (lastFrame.canonical.toolCalls?.length ?? 0) > 0 && ctx.forkCallId !== undefined) {
    frames.push(buildGeminiPairedForkToolFrame(ctx, lastFrame));
  } else if (ctx.childRoleContextFrameText !== undefined && ctx.childRoleContextFrameText.length > 0) {
    frames.push(buildGeminiUserFrame(`${lastFrame?.messageId ?? 'root'}:fork-context`, lastFrame?.messageId ?? null, promptParts.join('\n\n')));
  }
  return Object.freeze(frames);
}

/**
 * Appends synchronization or recovery notes in-place to a Google Gemini `tool` or `user` `WireFrameRecord`.
 *
 * Updates both `frame.canonical` and `frame.rawWireFrame`, targeting `targetCallId` (or the last
 * `functionResponse` part) on `role: 'tool'` frames and setting `response: { error: content }` when `opts?.isError === true`.
 *
 * @param {WireFrameRecord}                          frame        - Existing `tool` or `user` wire frame record.
 * @param {readonly string[]}                        notes        - Synchronization note strings to append.
 * @param {string | undefined}                       targetCallId - Optional tool `callId` to target on a `tool` frame.
 * @param {AppendToolResultNotesOptions | undefined} opts         - Optional error status override.
 *
 * @returns {WireFrameRecord} Updated wire frame record with appended notes.
 */
export function appendGeminiToolResultNotes(
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
    const toolNameByCallId = extractGeminiToolNamesFromWire(frame.rawWireFrame);
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
    const rawWireFrame = new TextEncoder().encode(JSON.stringify(projectCanonicalToGeminiContent(canonical, toolNameByCallId)));
    return Object.freeze<WireFrameRecord>({ ...frame, rawWireFrame, canonical });
  }
  const nextText = frame.canonical.visibleText.length > 0 ? `${frame.canonical.visibleText}\n${suffix}` : suffix;
  const canonical = Object.freeze<CanonicalMessage>({ ...frame.canonical, role: 'user', visibleText: nextText });
  const rawWireFrame = new TextEncoder().encode(JSON.stringify(projectCanonicalToGeminiContent(canonical)));
  return Object.freeze<WireFrameRecord>({ ...frame, rawWireFrame, canonical });
}
