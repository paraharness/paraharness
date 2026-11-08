import type { CanonicalMessage, CanonicalToolResult, WireFrameRecord } from '@metaharness/core';
import { projectCanonicalToGeminiContent } from './project-canonical-to-gemini-content.js';
import { stripGeminiThoughtPartsAndSignatures } from './strip-gemini-thought-parts-and-signatures.js';
import { tryDecodeGeminiWireContent } from './try-decode-gemini-wire-content.js';

/**
 * Parameters for transforming a single parent `WireFrameRecord` via `transformGeminiForkFrame()`.
 *
 * Supplies the parent frame, tombstone substitution flag, and optional tool-name lookup map.
 */
export interface TransformGeminiForkFrameParams {
  /** Source parent wire frame record to clone or sanitize. */
  readonly frame: WireFrameRecord;
  /** Whether cross-model tombstone substitution is active (`sourceModelId !== targetModelId`). */
  readonly substituteTombstones: boolean;
  /** Optional lookup from tool `callId` to tool `name`. */
  readonly toolNameByCallId: ReadonlyMap<string, string> | undefined;
}

/**
 * Transforms a single parent `WireFrameRecord` during Gemini `'clone-transcript'` fork preparation.
 *
 * Preserves `rawWireFrame` (`thought: true` and `thoughtSignature` fields) when `params.substituteTombstones === false`,
 * and strips thoughts/signatures while substituting `compactedTombstones` when `params.substituteTombstones === true`.
 *
 * @param {TransformGeminiForkFrameParams} params - Source frame, tombstone substitution flag, and tool-name lookup.
 *
 * @returns {WireFrameRecord} Cloned or sanitized Gemini wire frame record.
 */
export function transformGeminiForkFrame(params: TransformGeminiForkFrameParams): WireFrameRecord {
  const { frame, substituteTombstones, toolNameByCallId } = params;
  if (!substituteTombstones) {
    return frame;
  }
  const tombstones = frame.compactedTombstones ?? {};
  const updatedResults: CanonicalToolResult[] = [];
  for (const toolResult of frame.canonical.toolResults ?? []) {
    updatedResults.push(
      Object.freeze<CanonicalToolResult>({
        callId: toolResult.callId,
        content: tombstones[toolResult.callId] ?? toolResult.content,
        isError: toolResult.isError,
      }),
    );
  }
  const canonical = Object.freeze<CanonicalMessage>({
    role: frame.canonical.role,
    visibleText: frame.canonical.visibleText,
    toolCalls: frame.canonical.toolCalls,
    toolResults:
      frame.canonical.toolResults !== undefined ? Object.freeze(updatedResults) : undefined,
  });
  if (canonical.role === 'tool') {
    const contentTurn = projectCanonicalToGeminiContent(canonical, toolNameByCallId);
    return Object.freeze<WireFrameRecord>({
      messageId: frame.messageId,
      parentMessageId: frame.parentMessageId,
      vendorId: 'google',
      rawWireFrame: new TextEncoder().encode(JSON.stringify(contentTurn)),
      canonical,
      prefixDigest: frame.prefixDigest,
      compactedTombstones: frame.compactedTombstones,
    });
  }
  const parsed =
    tryDecodeGeminiWireContent(frame.rawWireFrame) ??
    projectCanonicalToGeminiContent(canonical, toolNameByCallId);
  const stripped = stripGeminiThoughtPartsAndSignatures(parsed);
  return Object.freeze<WireFrameRecord>({
    messageId: frame.messageId,
    parentMessageId: frame.parentMessageId,
    vendorId: 'google',
    rawWireFrame: new TextEncoder().encode(JSON.stringify(stripped)),
    canonical,
    prefixDigest: frame.prefixDigest,
    compactedTombstones: frame.compactedTombstones,
  });
}
