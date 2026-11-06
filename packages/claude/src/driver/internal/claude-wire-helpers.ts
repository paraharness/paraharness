import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ClaudeAccountSeatNode,
  ClaudeModelNode,
  EnvRef,
  ModelTurnRequest,
  WireFrameRecord,
  WireToolSchema,
} from '@harness-dsl/core';
import {
  ANTHROPIC_API_VERSION,
  CLAUDE_CREDENTIAL_FILENAMES,
} from '../default-claude-http-transport.constants.js';
import { projectCanonicalToAnthropicMessage } from './claude-wire-converter.js';

/**
 * Extracts an OAuth bearer token string from a Claude CLI `configDir` path on disk when present.
 *
 * Searches standard credential JSON files inside `configDir` (or `configDir` directly if it is a file)
 * and reads `accessToken`, `access_token`, `oauthToken`, `token`, or `claudeAiOauth.accessToken`.
 *
 * @param {string} configDir - Filesystem path to the Claude CLI configuration directory.
 *
 * @returns {string | undefined} Extracted OAuth bearer token, or `undefined` if no credential file exists.
 */
export function extractOAuthTokenFromConfigDir(configDir: string): string | undefined {
  if (!existsSync(configDir)) {
    return undefined;
  }
  const candidatePaths = statSync(configDir).isFile()
    ? [configDir]
    : CLAUDE_CREDENTIAL_FILENAMES.map((name) => join(configDir, name));
  for (const filePath of candidatePaths) {
    if (!existsSync(filePath)) {
      continue;
    }
    const raw = readFileSync(filePath, 'utf8').trim();
    if (raw.length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as Readonly<Record<string, unknown>>;
      const nested = parsed['claudeAiOauth'] as Readonly<Record<string, unknown>> | undefined;
      const token =
        nested?.['accessToken'] ??
        parsed['accessToken'] ??
        parsed['access_token'] ??
        parsed['oauthToken'] ??
        parsed['token'];
      if (typeof token === 'string' && token.trim().length > 0) {
        return token.trim();
      }
    } catch {
      return raw;
    }
  }
  return undefined;
}

/**
 * Resolves Anthropic authentication headers and seat metadata for a single turn invocation.
 *
 * Prioritizes OAuth credentials extracted from `seat.configDir` and falls back to `seat.apiKey`
 * (or the model pool's fallback seat `apiKey`) resolved via `resolveEnv`.
 *
 * @param {unknown}                                                      accountConfig - Seat config passed on `ModelTurnRequest`.
 * @param {ClaudeModelNode | undefined}                                  modelNode     - Optional bound `ClaudeModelNode`.
 * @param {((value: string | EnvRef) => string | undefined) | undefined} resolveEnv    - Optional runtime `EnvRef` resolver.
 *
 * @returns {Readonly<Record<string, unknown>>} Resolved `seatId`, `authSource`, and HTTP `headers`.
 */
export function resolveClaudeSeatAuth(
  accountConfig: unknown,
  modelNode: ClaudeModelNode | undefined,
  resolveEnv?: (value: string | EnvRef) => string | undefined,
): {
  readonly seatId: string | undefined;
  readonly authSource: 'cli-oauth' | 'api-key' | 'none';
  readonly headers: Readonly<Record<string, string>>;
} {
  const pool = modelNode?.accountPool;
  const candidateSeat = (accountConfig ?? pool?.items[0] ?? pool?.fallbackItem) as
    | ClaudeAccountSeatNode
    | undefined;
  const baseHeaders: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': ANTHROPIC_API_VERSION,
  };
  if (candidateSeat?.configDir !== undefined) {
    const diskToken = extractOAuthTokenFromConfigDir(candidateSeat.configDir);
    if (diskToken !== undefined) {
      baseHeaders['authorization'] = `Bearer ${diskToken}`;
      return { seatId: candidateSeat.id, authSource: 'cli-oauth', headers: Object.freeze(baseHeaders) };
    }
    if (candidateSeat.apiKey === undefined && pool?.fallbackItem?.apiKey === undefined) {
      baseHeaders['authorization'] = `Bearer oauth:${candidateSeat.id}:${candidateSeat.configDir}`;
      return { seatId: candidateSeat.id, authSource: 'cli-oauth', headers: Object.freeze(baseHeaders) };
    }
  }
  const fallbackSeat =
    candidateSeat?.apiKey !== undefined ? candidateSeat : (pool?.fallbackItem ?? candidateSeat);
  const rawKey = fallbackSeat?.apiKey;
  if (rawKey !== undefined) {
    const resolved = typeof rawKey === 'string' ? rawKey : resolveEnv?.(rawKey);
    if (resolved !== undefined && resolved.length > 0) {
      baseHeaders['x-api-key'] = resolved;
      return { seatId: fallbackSeat?.id, authSource: 'api-key', headers: Object.freeze(baseHeaders) };
    }
  }
  return { seatId: candidateSeat?.id, authSource: 'none', headers: Object.freeze(baseHeaders) };
}

/**
 * Resolves the wire tool schemas for `req` from `CompiledWirePrefix` or `req.wireToolSchemas`.
 *
 * Preserves identical tool definitions across both `'auto'` and `'none'` tool-choice turns so
 * Anthropic's KV prefix cache remains valid during epistemic flush turns.
 *
 * @param {ModelTurnRequest} req - Turn request containing `wirePrefix`, `roleKey`, and `wireToolSchemas`.
 *
 * @returns {readonly Readonly<Record<string, unknown>>[]} Anthropic wire tool descriptors.
 */
export function resolveAnthropicWireTools(
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
        name: schema.name,
        description: schema.description,
        input_schema: schema.inputJsonSchema,
      }),
    );
  }
  return Object.freeze(tools);
}

/**
 * Decodes a single `WireFrameRecord` into an Anthropic `/v1/messages` wire message object.
 *
 * Uses `rawWireFrame` directly when it already holds a valid Anthropic `{ role, content }` message
 * (preserving `thinking` blocks, `signature` fields, and `cache_control`), and otherwise projects
 * from `frame.canonical`.
 *
 * @param {WireFrameRecord} frame - Conversation history frame record.
 *
 * @returns {Readonly<Record<string, unknown>>} Anthropic wire message object.
 */
export function decodeFrameToAnthropicMessage(
  frame: WireFrameRecord,
): Readonly<Record<string, unknown>> {
  const text = new TextDecoder().decode(frame.rawWireFrame).trim();
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as Readonly<Record<string, unknown>>;
      if (
        (parsed['role'] === 'user' || parsed['role'] === 'assistant') &&
        Array.isArray(parsed['content'])
      ) {
        return parsed;
      }
    } catch {
      return projectCanonicalToAnthropicMessage(frame.canonical);
    }
  }
  return projectCanonicalToAnthropicMessage(frame.canonical);
}
