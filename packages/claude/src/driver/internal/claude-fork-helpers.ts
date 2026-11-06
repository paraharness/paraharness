import type {
  CanonicalMessage,
  CanonicalToolResult,
  ForkContext,
  PrecedingCompletedToolResult,
  WireFrameRecord,
} from '@harness-dsl/core';
import { projectCanonicalToAnthropicMessage } from './claude-wire-converter.js';
import { decodeFrameToAnthropicMessage } from './claude-wire-helpers.js';

/**
 * Slices `ctx.parentChain` up to and including `ctx.forkPointMessageId` when specified.
 *
 * Returns the full `ctx.parentChain` when `forkPointMessageId` is `null` or does not match an entry.
 *
 * @param {ForkContext} ctx - Fork preparation context carrying `parentChain` and `forkPointMessageId`.
 *
 * @returns {readonly WireFrameRecord[]} Parent frames up to the fork point.
 */
export function sliceClaudeParentChain(ctx: ForkContext): readonly WireFrameRecord[] {
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
 * Clones or re-projects a single parent `WireFrameRecord` during `'clone-transcript'` fork preparation.
 *
 * Preserves `rawWireFrame` with `cache_control: { type: 'ephemeral' }` on the fork point when
 * `substituteTombstones` is `false`, and projects from `CanonicalMessage` (applying `compactedTombstones`)
 * when `substituteTombstones` is `true`.
 *
 * @param {WireFrameRecord} frame                - Source parent wire frame record.
 * @param {boolean}         substituteTombstones - Whether cross-model tombstone substitution is active.
 * @param {boolean}         isForkPoint          - Whether this frame is the terminal fork-point frame.
 *
 * @returns {WireFrameRecord} Cloned or re-projected wire frame record.
 */
export function transformClaudeForkFrame(
  frame: WireFrameRecord,
  substituteTombstones: boolean,
  isForkPoint: boolean,
): WireFrameRecord {
  if (!substituteTombstones) {
    if (!isForkPoint) {
      return frame;
    }
    const wireObj = decodeFrameToAnthropicMessage(frame);
    const withCache = Object.freeze({ ...wireObj, cache_control: Object.freeze({ type: 'ephemeral' }) });
    return Object.freeze<WireFrameRecord>({
      ...frame,
      vendorId: 'anthropic',
      rawWireFrame: new TextEncoder().encode(JSON.stringify(withCache)),
    });
  }
  const tombstones = frame.compactedTombstones ?? {};
  const updatedResults: CanonicalToolResult[] = [];
  for (const res of frame.canonical.toolResults ?? []) {
    updatedResults.push(Object.freeze({ callId: res.callId, content: tombstones[res.callId] ?? res.content, isError: res.isError }));
  }
  const updatedCanonical = Object.freeze<CanonicalMessage>({
    ...frame.canonical,
    toolResults: frame.canonical.toolResults !== undefined ? Object.freeze(updatedResults) : undefined,
  });
  const projectedWire = projectCanonicalToAnthropicMessage(updatedCanonical);
  return Object.freeze<WireFrameRecord>({
    ...frame,
    vendorId: 'anthropic',
    rawWireFrame: new TextEncoder().encode(JSON.stringify(projectedWire)),
    canonical: updatedCanonical,
  });
}

/**
 * Synthesizes a single `role: 'tool'` `WireFrameRecord` pairing all `1..k` `toolCalls` on `forkPointFrame`.
 *
 * Maps preceding `(1..m)` calls from `ctx.precedingCompletedResults`, `ctx.forkCallId` to the child role
 * context and task prompt, and all other calls in `(1..k)` to `"[Dispatched/Deferred in parent turn]"`.
 *
 * @param {ForkContext}     ctx            - Fork context carrying `forkCallId` and `precedingCompletedResults`.
 * @param {WireFrameRecord} forkPointFrame - Assistant turn frame containing `toolCalls` `(1..k)`.
 *
 * @returns {WireFrameRecord} Synthesized `tool_result` wire frame pairing all `1..k` tool calls.
 */
export function buildClaudePairedForkToolFrame(
  ctx: ForkContext,
  forkPointFrame: WireFrameRecord,
): WireFrameRecord {
  const precedingByCallId = new Map<string, PrecedingCompletedToolResult>();
  for (const item of ctx.precedingCompletedResults ?? []) {
    precedingByCallId.set(item.callId, item);
  }
  const parts = [ctx.childRoleContextFrameText, ctx.childTaskPromptText].filter((s): s is string => Boolean(s && s.length > 0));
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
  const canonical = Object.freeze<CanonicalMessage>({
    role: 'tool',
    visibleText: '',
    toolCalls: undefined,
    toolResults: Object.freeze(toolResults),
  });
  return Object.freeze<WireFrameRecord>({
    messageId: `${forkPointFrame.messageId}:fork-tools:${ctx.forkCallId ?? 'batch'}`,
    parentMessageId: forkPointFrame.messageId,
    vendorId: 'anthropic',
    rawWireFrame: new TextEncoder().encode(JSON.stringify(projectCanonicalToAnthropicMessage(canonical))),
    canonical,
    prefixDigest: ctx.wirePrefix?.systemDigest ?? forkPointFrame.prefixDigest,
    compactedTombstones: undefined,
  });
}

/**
 * Constructs a `role: 'user'` `WireFrameRecord` seeded with `text` for Turn-0 or fork-point context injection.
 *
 * Encodes both the Anthropic `{ role: 'user', content: [{ type: 'text', text }] }` wire JSON and
 * the canonical user message representation.
 *
 * @param {string}        messageId       - Unique message frame identifier.
 * @param {string | null} parentMessageId - Preceding message frame identifier, or `null` for Turn 0.
 * @param {string}        text            - User prompt text content.
 *
 * @returns {WireFrameRecord} Frozen user `WireFrameRecord` for Anthropic `/v1/messages`.
 */
export function buildClaudeUserFrame(
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
    vendorId: 'anthropic',
    rawWireFrame: new TextEncoder().encode(JSON.stringify(projectCanonicalToAnthropicMessage(canonical))),
    canonical,
    prefixDigest: 'fork-seed',
    compactedTombstones: undefined,
  });
}
