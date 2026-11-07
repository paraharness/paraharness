import type {
  CanonicalMessage,
  CanonicalToolResult,
  ForkContext,
  PrecedingCompletedToolResult,
  WireFrameRecord,
} from '@harness-dsl/core';
import { stripGeminiThoughtPartsAndSignatures } from './gemini-wire-converter.js';
import {
  projectCanonicalToGeminiContent,
  tryDecodeGeminiWireContent,
} from './gemini-wire-helpers.js';

/**
 * Slices `ctx.parentChain` up to and including `ctx.forkPointMessageId` when specified.
 *
 * Returns the full `ctx.parentChain` when `forkPointMessageId` is `null` or does not match an entry.
 *
 * @param {ForkContext} ctx - Fork preparation context carrying `parentChain` and `forkPointMessageId`.
 *
 * @returns {readonly WireFrameRecord[]} Parent frames up to the fork point.
 */
export function sliceGeminiParentChain(ctx: ForkContext): readonly WireFrameRecord[] {
  if (ctx.forkPointMessageId === null) {
    return ctx.parentChain;
  }
  const sliced: WireFrameRecord[] = [];
  for (const frame of ctx.parentChain) {
    sliced.push(frame);
    if (frame.messageId === ctx.forkPointMessageId) {
      return Object.freeze(sliced);
    }
  }
  return ctx.parentChain;
}

/**
 * Transforms a single parent `WireFrameRecord` during Gemini `'clone-transcript'` fork preparation.
 *
 * Preserves `rawWireFrame` (`thought: true` and `thoughtSignature` fields) when `substituteTombstones === false`,
 * and strips thoughts/signatures while substituting `compactedTombstones` when `substituteTombstones === true`.
 *
 * @param {WireFrameRecord}                         frame            - Source parent wire frame record.
 * @param {boolean}                                 substitute       - Whether cross-model tombstone substitution is active.
 * @param {ReadonlyMap<string, string> | undefined} toolNameByCallId - Optional lookup from `callId` to tool name.
 *
 * @returns {WireFrameRecord} Cloned or sanitized Gemini wire frame record.
 */
export function transformGeminiForkFrame(
  frame: WireFrameRecord,
  substitute: boolean,
  toolNameByCallId?: ReadonlyMap<string, string>,
): WireFrameRecord {
  if (!substitute) {
    return frame;
  }
  const tombstones = frame.compactedTombstones ?? {};
  const updatedResults: CanonicalToolResult[] = [];
  for (const res of frame.canonical.toolResults ?? []) {
    updatedResults.push(Object.freeze({ callId: res.callId, content: tombstones[res.callId] ?? res.content, isError: res.isError }));
  }
  const canonical = Object.freeze<CanonicalMessage>({
    ...frame.canonical,
    toolResults: frame.canonical.toolResults !== undefined ? Object.freeze(updatedResults) : undefined,
  });
  if (canonical.role === 'tool') {
    const contentTurn = projectCanonicalToGeminiContent(canonical, toolNameByCallId);
    return Object.freeze<WireFrameRecord>({ ...frame, vendorId: 'google', rawWireFrame: new TextEncoder().encode(JSON.stringify(contentTurn)), canonical });
  }
  const parsed =
    tryDecodeGeminiWireContent(frame.rawWireFrame) ??
    projectCanonicalToGeminiContent(canonical, toolNameByCallId);
  const stripped = stripGeminiThoughtPartsAndSignatures(parsed);
  return Object.freeze<WireFrameRecord>({ ...frame, vendorId: 'google', rawWireFrame: new TextEncoder().encode(JSON.stringify(stripped)), canonical });
}

/**
 * Synthesizes a single `role: 'tool'` `WireFrameRecord` pairing all `1..k` `toolCalls` on `forkPointFrame` with `functionResponse` parts.
 *
 * Maps preceding `(1..m)` calls from `ctx.precedingCompletedResults`, `ctx.forkCallId` to the child role
 * context and task prompt, and all other calls in `(1..k)` to `"[Dispatched/Deferred in parent turn]"`.
 *
 * @param {ForkContext}     ctx            - Fork context carrying `forkCallId` and `precedingCompletedResults`.
 * @param {WireFrameRecord} forkPointFrame - Assistant turn frame containing `toolCalls` `(1..k)`.
 *
 * @returns {WireFrameRecord} Synthesized `functionResponse` wire frame pairing all `1..k` tool calls.
 */
export function buildGeminiPairedForkToolFrame(
  ctx: ForkContext,
  forkPointFrame: WireFrameRecord,
): WireFrameRecord {
  const precedingByCallId = new Map<string, PrecedingCompletedToolResult>();
  for (const item of ctx.precedingCompletedResults ?? []) {
    precedingByCallId.set(item.callId, item);
  }
  const toolNameByCallId = new Map<string, string>();
  const parts: string[] = [];
  if (ctx.childRoleContextFrameText !== undefined && ctx.childRoleContextFrameText.length > 0) {
    parts.push(ctx.childRoleContextFrameText);
  }
  if (ctx.childTaskPromptText !== undefined && ctx.childTaskPromptText.length > 0) {
    parts.push(ctx.childTaskPromptText);
  }
  const forkCallText = parts.length > 0 ? parts.join('\n\n') : '[Forked child session]';
  const toolResults: CanonicalToolResult[] = [];
  for (const call of forkPointFrame.canonical.toolCalls ?? []) {
    toolNameByCallId.set(call.id, call.name);
    const preceding = precedingByCallId.get(call.id);
    if (preceding !== undefined) {
      toolResults.push(Object.freeze({ callId: call.id, content: preceding.content, isError: Boolean(preceding.isError) }));
    } else {
      const content = call.id === ctx.forkCallId ? forkCallText : '[Dispatched/Deferred in parent turn]';
      toolResults.push(Object.freeze({ callId: call.id, content, isError: false }));
    }
  }
  const canonical = Object.freeze<CanonicalMessage>({ role: 'tool', visibleText: '', toolCalls: undefined, toolResults: Object.freeze(toolResults) });
  return Object.freeze<WireFrameRecord>({
    messageId: `${forkPointFrame.messageId}:fork-tools:${ctx.forkCallId ?? 'batch'}`,
    parentMessageId: forkPointFrame.messageId,
    vendorId: 'google',
    rawWireFrame: new TextEncoder().encode(JSON.stringify(projectCanonicalToGeminiContent(canonical, toolNameByCallId))),
    canonical,
    prefixDigest: ctx.wirePrefix?.systemDigest ?? forkPointFrame.prefixDigest,
    compactedTombstones: undefined,
  });
}

/**
 * Constructs a `role: 'user'` `WireFrameRecord` seeded with `text` for Turn-0 or fork-point context injection.
 *
 * Encodes both the Gemini `{ role: 'user', parts: [{ text }] }` wire JSON and the canonical user message.
 *
 * @param {string}        messageId       - Unique message frame identifier.
 * @param {string | null} parentMessageId - Preceding message frame identifier, or `null` for Turn 0.
 * @param {string}        text            - User prompt text content.
 *
 * @returns {WireFrameRecord} Frozen user `WireFrameRecord` for Gemini `generateContent`.
 */
export function buildGeminiUserFrame(
  messageId: string,
  parentMessageId: string | null,
  text: string,
): WireFrameRecord {
  const canonical = Object.freeze<CanonicalMessage>({ role: 'user', visibleText: text, toolCalls: undefined, toolResults: undefined });
  return Object.freeze<WireFrameRecord>({
    messageId,
    parentMessageId,
    vendorId: 'google',
    rawWireFrame: new TextEncoder().encode(JSON.stringify(projectCanonicalToGeminiContent(canonical))),
    canonical,
    prefixDigest: 'fork-seed',
    compactedTombstones: undefined,
  });
}
