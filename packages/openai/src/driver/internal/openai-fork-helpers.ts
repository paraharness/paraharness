import type {
  CanonicalMessage,
  CanonicalToolResult,
  ForkContext,
  OpenAiAccountSeatNode,
  PrecedingCompletedToolResult,
  PrepareForkTarget,
  WireFrameRecord,
} from '@harness-dsl/core';
import { stripOpenAiServerItemIdsAndEncryptedContent } from './openai-wire-converter.js';
import { decodeFrameToOpenAiWire, projectCanonicalToOpenAiWire } from './openai-wire-helpers.js';

/**
 * Slices `ctx.parentChain` up to and including `ctx.forkPointMessageId` when specified.
 *
 * Returns the full `ctx.parentChain` when `forkPointMessageId` is `null` or does not match an entry.
 *
 * @param {ForkContext} ctx - Fork preparation context carrying `parentChain` and `forkPointMessageId`.
 *
 * @returns {readonly WireFrameRecord[]} Parent frames up to the fork point.
 */
export function sliceOpenAiParentChain(ctx: ForkContext): readonly WireFrameRecord[] {
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
 * Transforms a single parent `WireFrameRecord` during OpenAI `'clone-transcript'` fork preparation.
 *
 * Preserves `previous_response_id`, server item IDs (`rs_...`, `fc_...`, `msg_...`), and `encrypted_content`
 * on same-model, same-seat forks (`substituteTombstones === false`), and strips them while substituting
 * `compactedTombstones` when `substituteTombstones === true` or on cross-seat failover.
 *
 * @param {WireFrameRecord}   frame       - Source parent wire frame record.
 * @param {PrepareForkTarget} target      - Target model configuration and `substituteTombstones` flag.
 * @param {boolean}           isForkPoint - Whether this frame is the terminal fork-point frame.
 *
 * @returns {WireFrameRecord} Cloned or sanitized OpenAI wire frame record.
 */
export function transformOpenAiForkFrame(
  frame: WireFrameRecord,
  target: PrepareForkTarget,
  isForkPoint: boolean,
): WireFrameRecord {
  const envelope = decodeFrameToOpenAiWire(frame);
  const targetSeat = target.accountConfig as OpenAiAccountSeatNode | undefined;
  const isCrossSeat =
    typeof envelope['seatId'] === 'string' && targetSeat?.id !== undefined && envelope['seatId'] !== targetSeat.id;
  if (!target.substituteTombstones && !isCrossSeat) {
    if (isForkPoint && typeof envelope['responseId'] === 'string') {
      const branched = Object.freeze({ ...envelope, previous_response_id: envelope['responseId'] });
      return Object.freeze<WireFrameRecord>({ ...frame, vendorId: 'openai', rawWireFrame: new TextEncoder().encode(JSON.stringify(branched)) });
    }
    return frame;
  }
  const tombstones = target.substituteTombstones ? (frame.compactedTombstones ?? {}) : {};
  const updatedResults: CanonicalToolResult[] = [];
  for (const res of frame.canonical.toolResults ?? []) {
    updatedResults.push(Object.freeze({ callId: res.callId, content: tombstones[res.callId] ?? res.content, isError: res.isError }));
  }
  const canonical = Object.freeze<CanonicalMessage>({
    ...frame.canonical,
    toolResults: frame.canonical.toolResults !== undefined ? Object.freeze(updatedResults) : undefined,
  });
  const baseEnvelope = frame.canonical.role === 'tool' ? projectCanonicalToOpenAiWire(canonical) : stripOpenAiServerItemIdsAndEncryptedContent(envelope);
  return Object.freeze<WireFrameRecord>({
    ...frame,
    vendorId: 'openai',
    rawWireFrame: new TextEncoder().encode(JSON.stringify(baseEnvelope)),
    canonical,
  });
}

/**
 * Synthesizes a single `role: 'tool'` `WireFrameRecord` pairing all `1..k` `toolCalls` on `forkPointFrame` with `function_call_output` items.
 *
 * Maps preceding `(1..m)` calls from `ctx.precedingCompletedResults`, `ctx.forkCallId` to the child role
 * context and task prompt, and all other calls in `(1..k)` to `"[Dispatched/Deferred in parent turn]"`.
 *
 * @param {ForkContext}     ctx            - Fork context carrying `forkCallId` and `precedingCompletedResults`.
 * @param {WireFrameRecord} forkPointFrame - Assistant turn frame containing `toolCalls` `(1..k)`.
 *
 * @returns {WireFrameRecord} Synthesized `function_call_output` wire frame pairing all `1..k` tool calls.
 */
export function buildOpenAiPairedForkToolFrame(
  ctx: ForkContext,
  forkPointFrame: WireFrameRecord,
): WireFrameRecord {
  const precedingByCallId = new Map<string, PrecedingCompletedToolResult>();
  for (const item of ctx.precedingCompletedResults ?? []) {
    precedingByCallId.set(item.callId, item);
  }
  const parts: string[] = [];
  if (ctx.childRoleContextFrameText !== undefined && ctx.childRoleContextFrameText.length > 0) parts.push(ctx.childRoleContextFrameText);
  if (ctx.childTaskPromptText !== undefined && ctx.childTaskPromptText.length > 0) parts.push(ctx.childTaskPromptText);
  const forkCallText = parts.length > 0 ? parts.join('\n\n') : '[Forked child session]';
  const toolResults: CanonicalToolResult[] = [];
  for (const call of forkPointFrame.canonical.toolCalls ?? []) {
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
    vendorId: 'openai',
    rawWireFrame: new TextEncoder().encode(JSON.stringify(projectCanonicalToOpenAiWire(canonical))),
    canonical,
    prefixDigest: ctx.wirePrefix?.systemDigest ?? forkPointFrame.prefixDigest,
    compactedTombstones: undefined,
  });
}

/**
 * Constructs a `role: 'user'` `WireFrameRecord` seeded with `text` for Turn-0 or fork-point context injection.
 *
 * Encodes both the OpenAI `{ items: [{ type: 'message', role: 'user', content }] }` wire JSON and
 * the canonical user message representation.
 *
 * @param {string}        messageId       - Unique message frame identifier.
 * @param {string | null} parentMessageId - Preceding message frame identifier, or `null` for Turn 0.
 * @param {string}        text            - User prompt text content.
 *
 * @returns {WireFrameRecord} Frozen user `WireFrameRecord` for OpenAI `/v1/responses`.
 */
export function buildOpenAiUserFrame(
  messageId: string,
  parentMessageId: string | null,
  text: string,
): WireFrameRecord {
  const canonical = Object.freeze<CanonicalMessage>({
    role: 'user',
    visibleText: text,
    toolCalls: undefined,
    toolResults: undefined,
  });
  return Object.freeze<WireFrameRecord>({
    messageId,
    parentMessageId,
    vendorId: 'openai',
    rawWireFrame: new TextEncoder().encode(JSON.stringify(projectCanonicalToOpenAiWire(canonical))),
    canonical,
    prefixDigest: 'fork-seed',
    compactedTombstones: undefined,
  });
}
