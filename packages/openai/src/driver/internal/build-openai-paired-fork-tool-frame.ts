import type {
  CanonicalMessage,
  CanonicalToolResult,
  ForkContext,
  PrecedingCompletedToolResult,
  WireFrameRecord,
} from '@metaharness/core';
import { formatOpenAiForkPromptText } from './format-openai-fork-prompt-text.js';
import { projectCanonicalToOpenAiWire } from './project-canonical-to-openai-wire.js';

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
  for (const precedingEntry of ctx.precedingCompletedResults ?? []) {
    precedingByCallId.set(precedingEntry.callId, precedingEntry);
  }
  const combinedPrompt = formatOpenAiForkPromptText(ctx);
  const forkCallText = combinedPrompt.length > 0 ? combinedPrompt : '[Forked child session]';
  const toolResults: CanonicalToolResult[] = [];
  for (const call of forkPointFrame.canonical.toolCalls ?? []) {
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
    vendorId: 'openai',
    rawWireFrame: new TextEncoder().encode(
      JSON.stringify(projectCanonicalToOpenAiWire(canonical)),
    ),
    canonical,
    prefixDigest: ctx.wirePrefix?.systemDigest ?? forkPointFrame.prefixDigest,
    compactedTombstones: undefined,
  });
}
