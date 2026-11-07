import type {
  CanonicalMessage,
  EnvRef,
  ModelTurnRequest,
  OpenAiAccountSeatNode,
  OpenAiModelNode,
  WireFrameRecord,
  WireToolSchema,
} from '@harness-dsl/core';

/**
 * Resolves OpenAI authentication headers and active seat metadata for a single turn invocation.
 *
 * Evaluates symbolic `EnvRef` API keys via `resolveEnv` or extracts Codex CLI `configDir` tokens.
 *
 * @param {unknown}                                                      accountConfig - Seat config passed on `ModelTurnRequest`.
 * @param {OpenAiModelNode | undefined}                                  modelNode     - Optional bound `OpenAiModelNode`.
 * @param {((value: string | EnvRef) => string | undefined) | undefined} resolveEnv    - Optional runtime `EnvRef` resolver.
 *
 * @returns {Readonly<Record<string, unknown>>} Resolved `seatId`, `authSource`, and HTTP `headers`.
 */
export function resolveOpenAiSeatAuth(
  accountConfig: unknown,
  modelNode: OpenAiModelNode | undefined,
  resolveEnv?: (value: string | EnvRef) => string | undefined,
): {
  readonly seatId: string | undefined;
  readonly authSource: 'cli-oauth' | 'api-key' | 'none';
  readonly headers: Readonly<Record<string, string>>;
} {
  const pool = modelNode?.accountPool;
  const seat = (accountConfig ?? pool?.items[0] ?? pool?.fallbackItem) as
    | OpenAiAccountSeatNode
    | undefined;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (seat?.apiKey !== undefined) {
    const resolved = typeof seat.apiKey === 'string' ? seat.apiKey : resolveEnv?.(seat.apiKey);
    if (resolved !== undefined && resolved.length > 0) {
      headers['authorization'] = `Bearer ${resolved}`;
      return { seatId: seat.id, authSource: 'api-key', headers: Object.freeze(headers) };
    }
  }
  if (seat?.configDir !== undefined) {
    headers['authorization'] = `Bearer codex-oauth:${seat.id}:${seat.configDir}`;
    return { seatId: seat.id, authSource: 'cli-oauth', headers: Object.freeze(headers) };
  }
  return { seatId: seat?.id, authSource: 'none', headers: Object.freeze(headers) };
}

/**
 * Resolves OpenAI Responses API function tool definitions from `CompiledWirePrefix` or `req.wireToolSchemas`.
 *
 * Preserves identical tool definitions across `'auto'` and `'none'` tool-choice turns.
 *
 * @param {ModelTurnRequest} req - Turn request containing `wirePrefix`, `roleKey`, and `wireToolSchemas`.
 *
 * @returns {readonly Readonly<Record<string, unknown>>[]} OpenAI function tool descriptors.
 */
export function resolveOpenAiWireTools(
  req: ModelTurnRequest,
): readonly Readonly<Record<string, unknown>>[] {
  const byRole = req.wirePrefix?.wireToolSchemasByRoleKey;
  const schemas: readonly WireToolSchema[] =
    (req.roleKey !== undefined ? byRole?.[req.roleKey] : undefined) ??
    byRole?.['*'] ??
    req.wireToolSchemas ??
    [];
  const tools: Readonly<Record<string, unknown>>[] = [];
  for (const schema of schemas) {
    tools.push(
      Object.freeze({
        type: 'function',
        name: schema.name,
        description: schema.description,
        parameters: schema.inputJsonSchema,
        strict: true,
      }),
    );
  }
  return Object.freeze(tools);
}

/**
 * Projects a vendor-neutral `CanonicalMessage` into an OpenAI Responses API wire frame object.
 *
 * Maps `tool` frames to `function_call_output` items, `assistant` frames to `message` and `function_call`
 * items, and `user` frames to `input_text` message items.
 *
 * @param {CanonicalMessage} canonical - Vendor-neutral canonical message to project.
 *
 * @returns {Readonly<Record<string, unknown>>} OpenAI wire envelope containing `items`.
 */
export function projectCanonicalToOpenAiWire(
  canonical: CanonicalMessage,
): Readonly<Record<string, unknown>> {
  const items: Readonly<Record<string, unknown>>[] = [];
  if (canonical.role === 'tool') {
    for (const res of canonical.toolResults ?? []) {
      items.push(
        res.isError
          ? Object.freeze({ type: 'function_call_output', call_id: res.callId, output: res.content, is_error: true })
          : Object.freeze({ type: 'function_call_output', call_id: res.callId, output: res.content }),
      );
    }
    return Object.freeze({ items: Object.freeze(items) });
  }
  if (canonical.role === 'assistant') {
    if (canonical.visibleText.length > 0 || (canonical.toolCalls?.length ?? 0) === 0) {
      const content = Object.freeze([Object.freeze({ type: 'output_text', text: canonical.visibleText })]);
      items.push(Object.freeze({ type: 'message', role: 'assistant', content }));
    }
    for (const call of canonical.toolCalls ?? []) {
      items.push(Object.freeze({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.argsJson }));
    }
    return Object.freeze({ items: Object.freeze(items) });
  }
  const content = Object.freeze([Object.freeze({ type: 'input_text', text: canonical.visibleText })]);
  items.push(Object.freeze({ type: 'message', role: 'user', content }));
  return Object.freeze({ items: Object.freeze(items) });
}

/**
 * Decodes a `WireFrameRecord` into its OpenAI wire envelope `{ seatId?, responseId?, previous_response_id?, items }`.
 *
 * Uses `rawWireFrame` directly when it encodes an OpenAI `{ items }` envelope and otherwise projects
 * from `frame.canonical`.
 *
 * @param {WireFrameRecord} frame - Conversation history frame record.
 *
 * @returns {Readonly<Record<string, unknown>>} Decoded OpenAI wire envelope.
 */
export function decodeFrameToOpenAiWire(frame: WireFrameRecord): Readonly<Record<string, unknown>> {
  const text = new TextDecoder().decode(frame.rawWireFrame).trim();
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as Readonly<Record<string, unknown>>;
      if (Array.isArray(parsed['items'])) {
        return parsed;
      }
    } catch {
      return projectCanonicalToOpenAiWire(frame.canonical);
    }
  }
  return projectCanonicalToOpenAiWire(frame.canonical);
}
