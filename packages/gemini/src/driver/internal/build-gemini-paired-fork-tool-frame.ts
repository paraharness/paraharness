import type {
  CanonicalMessage,
  CanonicalToolResult,
  ForkContext,
  PrecedingCompletedToolResult,
  WireFrameRecord,
} from '@harness-dsl/core';
import { formatGeminiForkPromptText } from './format-gemini-fork-prompt-text.js';
import { projectCanonicalToGeminiContent } from './project-canonical-to-gemini-content.js';

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
  for (const precedingEntry of ctx.precedingCompletedResults ?? []) {
    precedingByCallId.set(precedingEntry.callId, precedingEntry);
  }
  const toolNameByCallId = new Map<string, string>();
  const combinedPrompt = formatGeminiForkPromptText(ctx);
  const forkCallText = combinedPrompt.length > 0 ? combinedPrompt : '[Forked child session]';
  const toolResults: CanonicalToolResult[] = [];
  for (const call of forkPointFrame.canonical.toolCalls ?? []) {
    toolNameByCallId.set(call.id, call.name);
    const preceding = precedingByCallId.get(call.id);
    if (preceding !== undefined) {
      toolResults.push(
        Object.freeze<CanonicalToolResult>({
          callId: call.id,
          content: preceding.content,
          isError: Boolean(preceding.isError),
        }),
      );
    } else {
      const content =
        call.id === ctx.forkCallId ? forkCallText : '[Dispatched/Deferred in parent turn]';
      toolResults.push(
        Object.freeze<CanonicalToolResult>({
          callId: call.id,
          content,
          isError: false,
        }),
      );
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
    vendorId: 'google',
    rawWireFrame: new TextEncoder().encode(
      JSON.stringify(projectCanonicalToGeminiContent(canonical, toolNameByCallId)),
    ),
    canonical,
    prefixDigest: ctx.wirePrefix?.systemDigest ?? forkPointFrame.prefixDigest,
    compactedTombstones: undefined,
  });
}
