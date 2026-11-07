import type {
  CanonicalMessage,
  EnvRef,
  GeminiAccountSeatNode,
  GeminiModelNode,
  WireFrameRecord,
} from '@harness-dsl/core';

/**
 * Resolves Google Gemini authentication headers and active seat metadata for a single turn invocation.
 *
 * Evaluates symbolic `EnvRef` API keys (`x-goog-api-key`) via `resolveEnv` or CLI/ADC `configDir` OAuth tokens.
 *
 * @param {unknown}                                                      accountConfig - Seat config passed on `ModelTurnRequest`.
 * @param {GeminiModelNode | undefined}                                  modelNode     - Optional bound `GeminiModelNode`.
 * @param {((value: string | EnvRef) => string | undefined) | undefined} resolveEnv    - Optional runtime `EnvRef` resolver.
 *
 * @returns {Readonly<Record<string, unknown>>} Resolved `seatId`, `authSource`, and HTTP `headers`.
 */
export function resolveGeminiSeatAuth(
  accountConfig: unknown,
  modelNode: GeminiModelNode | undefined,
  resolveEnv?: (value: string | EnvRef) => string | undefined,
): {
  readonly seatId: string | undefined;
  readonly authSource: 'cli-oauth' | 'api-key' | 'none';
  readonly headers: Readonly<Record<string, string>>;
} {
  const pool = modelNode?.accountPool;
  const seat = (accountConfig ?? pool?.items[0] ?? pool?.fallbackItem) as
    | GeminiAccountSeatNode
    | undefined;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (seat?.apiKey !== undefined) {
    const resolved = typeof seat.apiKey === 'string' ? seat.apiKey : resolveEnv?.(seat.apiKey);
    if (resolved !== undefined && resolved.length > 0) {
      headers['x-goog-api-key'] = resolved;
      return { seatId: seat.id, authSource: 'api-key', headers: Object.freeze(headers) };
    }
  }
  if (seat?.configDir !== undefined) {
    headers['authorization'] = `Bearer gemini-oauth:${seat.id}:${seat.configDir}`;
    return { seatId: seat.id, authSource: 'cli-oauth', headers: Object.freeze(headers) };
  }
  return { seatId: seat?.id, authSource: 'none', headers: Object.freeze(headers) };
}

/**
 * Attempts to decode `rawWireFrame` bytes as a native Gemini `{ role: 'user' | 'model', parts }` content object.
 *
 * Returns `undefined` when `rawWireFrame` is empty, fails JSON parsing, or encodes a non-Gemini wire format
 * (such as Anthropic `{ role, content }` or OpenAI `{ items }`).
 *
 * @param {Uint8Array} rawWireFrame - Raw wire frame bytes from a `WireFrameRecord`.
 *
 * @returns {Readonly<Record<string, unknown>> | undefined} Decoded Gemini content object, or `undefined`.
 */
export function tryDecodeGeminiWireContent(
  rawWireFrame: Uint8Array,
): Readonly<Record<string, unknown>> | undefined {
  const rawText = new TextDecoder().decode(rawWireFrame).trim();
  if (!rawText.startsWith('{')) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(rawText) as Readonly<Record<string, unknown>>;
    if ((parsed['role'] === 'user' || parsed['role'] === 'model') && Array.isArray(parsed['parts'])) {
      return parsed;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Projects a vendor-neutral `CanonicalMessage` into a Gemini `generateContent` content turn (`{ role, parts }`).
 *
 * Maps `tool` results to `functionResponse` parts (`{ error: content }` when `isError: true`, `{ result: content }`
 * when `isError: false`), `assistant` tool calls to `functionCall` parts, and `user` text to `{ text }` parts.
 *
 * @param {CanonicalMessage}                        canonical        - Vendor-neutral canonical message.
 * @param {ReadonlyMap<string, string> | undefined} toolNameByCallId - Optional lookup from `callId` to tool name.
 *
 * @returns {Readonly<Record<string, unknown>>} Gemini `{ role: 'user' | 'model', parts }` content object.
 */
export function projectCanonicalToGeminiContent(
  canonical: CanonicalMessage,
  toolNameByCallId?: ReadonlyMap<string, string>,
): Readonly<Record<string, unknown>> {
  const parts: Readonly<Record<string, unknown>>[] = [];
  if (canonical.role === 'tool') {
    for (const res of canonical.toolResults ?? []) {
      const name = toolNameByCallId?.get(res.callId) ?? res.callId;
      const responseObj = res.isError ? Object.freeze({ error: res.content }) : Object.freeze({ result: res.content });
      parts.push(Object.freeze({ functionResponse: Object.freeze({ id: res.callId, name, response: responseObj }) }));
    }
    return Object.freeze({ role: 'user', parts: Object.freeze(parts) });
  }
  if (canonical.role === 'assistant') {
    if (canonical.visibleText.length > 0 || (canonical.toolCalls?.length ?? 0) === 0) {
      parts.push(Object.freeze({ text: canonical.visibleText }));
    }
    for (const call of canonical.toolCalls ?? []) {
      const args = call.argsJson.trim().length > 0 ? (JSON.parse(call.argsJson) as Readonly<Record<string, unknown>>) : {};
      parts.push(Object.freeze({ functionCall: Object.freeze({ id: call.id, name: call.name, args }) }));
    }
    return Object.freeze({ role: 'model', parts: Object.freeze(parts) });
  }
  parts.push(Object.freeze({ text: canonical.visibleText }));
  return Object.freeze({ role: 'user', parts: Object.freeze(parts) });
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
  const contents: Array<{ readonly role: string; readonly parts: Readonly<Record<string, unknown>>[] }> = [];
  for (const frame of frames) {
    const contentTurn =
      tryDecodeGeminiWireContent(frame.rawWireFrame) ??
      projectCanonicalToGeminiContent(frame.canonical, toolNameByCallId);
    const role = contentTurn['role'] === 'model' ? 'model' : 'user';
    const rawParts = (contentTurn['parts'] as readonly Readonly<Record<string, unknown>>[]) ?? [];
    const parts: Readonly<Record<string, unknown>>[] = [];
    for (const part of rawParts) {
      const fr = part['functionResponse'] as Readonly<Record<string, unknown>> | undefined;
      const hasFallbackName = fr !== undefined && typeof fr['id'] === 'string' && fr['name'] === fr['id'] && toolNameByCallId.has(fr['id']);
      parts.push(hasFallbackName ? Object.freeze({ ...part, functionResponse: Object.freeze({ ...fr, name: toolNameByCallId.get(fr['id'] as string) }) }) : part);
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
    frozenContents.push(Object.freeze({ role: entry.role, parts: Object.freeze(entry.parts) }));
  }
  return Object.freeze(frozenContents);
}
