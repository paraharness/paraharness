import type { WireFrameRecord } from '@harness-dsl/core';
import { projectCanonicalToGeminiContent } from './project-canonical-to-gemini-content.js';
import { tryDecodeGeminiWireContent } from './try-decode-gemini-wire-content.js';

/**
 * Normalizes a single Gemini content part by resolving any fallback `functionResponse.name` via `toolNameByCallId`.
 *
 * Returns the original `part` unchanged when no fallback tool name substitution is needed.
 *
 * @param {Readonly<Record<string, unknown>>} part             - Raw Gemini content part.
 * @param {ReadonlyMap<string, string>}       toolNameByCallId - Map from tool `callId` to tool `name`.
 *
 * @returns {Readonly<Record<string, unknown>>} Normalized Gemini content part.
 */
function normalizeGeminiContentPartToolName(
  part: Readonly<Record<string, unknown>>,
  toolNameByCallId: ReadonlyMap<string, string>,
): Readonly<Record<string, unknown>> {
  const fnResponse = part['functionResponse'] as Readonly<Record<string, unknown>> | undefined;
  const callId = fnResponse?.['id'];
  if (
    fnResponse !== undefined &&
    typeof callId === 'string' &&
    fnResponse['name'] === callId &&
    toolNameByCallId.has(callId)
  ) {
    return Object.freeze({
      ...part,
      functionResponse: Object.freeze({
        ...fnResponse,
        name: toolNameByCallId.get(callId),
      }),
    });
  }
  return part;
}

/**
 * Decodes a `WireFrameRecord` into a Gemini `{ role, parts }` content object and coalesces consecutive same-role turns.
 *
 * Preserves `thought: true` and `thoughtSignature` fields from `rawWireFrame` and guarantees strict
 * `user` / `model` role alternation across the returned `contents` array.
 *
 * @param {readonly WireFrameRecord[]} frames - Ordered conversation history frames.
 *
 * @returns {readonly Readonly<Record<string, unknown>>[]} Role-alternating Gemini `contents` turns.
 */
export function decodeHistoryToAlternatingGeminiContents(
  frames: readonly WireFrameRecord[],
): readonly Readonly<Record<string, unknown>>[] {
  const toolNameByCallId = new Map<string, string>();
  for (const frame of frames) {
    for (const call of frame.canonical.toolCalls ?? []) {
      toolNameByCallId.set(call.id, call.name);
    }
  }
  const contents: Array<{
    readonly role: string;
    readonly parts: Readonly<Record<string, unknown>>[];
  }> = [];
  for (const frame of frames) {
    const contentTurn =
      tryDecodeGeminiWireContent(frame.rawWireFrame) ??
      projectCanonicalToGeminiContent(frame.canonical, toolNameByCallId);
    const role = contentTurn['role'] === 'model' ? 'model' : 'user';
    const rawParts =
      (contentTurn['parts'] as readonly Readonly<Record<string, unknown>>[]) ?? [];
    const parts: Readonly<Record<string, unknown>>[] = [];
    for (const part of rawParts) {
      parts.push(normalizeGeminiContentPartToolName(part, toolNameByCallId));
    }
    const prev = contents[contents.length - 1];
    if (prev !== undefined && prev.role === role) {
      prev.parts.push(...parts);
    } else {
      contents.push({ role, parts });
    }
  }
  const frozenContents: Readonly<Record<string, unknown>>[] = [];
  for (const entry of contents) {
    frozenContents.push(
      Object.freeze({ role: entry.role, parts: Object.freeze(entry.parts) }),
    );
  }
  return Object.freeze(frozenContents);
}
