import type {
  OpenAiAccountSeatNode,
  OpenAiModelNode,
  RuntimeDriverContext,
} from '@paraharness/core';
import type { OpenAiSeatAuth } from './openai-seat-auth.js';

/**
 * Parameters for resolving OpenAI seat authentication via `resolveOpenAiSeatAuth()`.
 *
 * Combines the turn-level `accountConfig`, bound `modelNode`, and optional `driverCtx`.
 */
export interface ResolveOpenAiSeatAuthParams {
  /** Optional seat configuration supplied on `ModelTurnRequest.accountConfig`. */
  readonly accountConfig: unknown;
  /** Optional passive `OpenAiModelNode` bound to the driver instance. */
  readonly modelNode: OpenAiModelNode | undefined;
  /** Optional runtime driver context providing `resolveEnv` for symbolic `EnvRef` keys. */
  readonly driverCtx: RuntimeDriverContext | undefined;
}

/**
 * Resolves OpenAI authentication headers and active seat metadata for a single turn invocation.
 *
 * Evaluates symbolic `EnvRef` API keys via `driverCtx.resolveEnv` or extracts Codex CLI `configDir` tokens.
 *
 * @param {ResolveOpenAiSeatAuthParams} params - Account config, bound model node, and runtime driver context.
 *
 * @returns {OpenAiSeatAuth} Resolved `seatId`, `authSource`, and HTTP `headers`.
 */
export function resolveOpenAiSeatAuth(params: ResolveOpenAiSeatAuthParams): OpenAiSeatAuth {
  const { accountConfig, modelNode, driverCtx } = params;
  const pool = modelNode?.accountPool;
  const seat = (accountConfig ?? pool?.items[0] ?? pool?.fallbackItem) as
    | OpenAiAccountSeatNode
    | undefined;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (seat?.apiKey !== undefined) {
    const resolved =
      typeof seat.apiKey === 'string' ? seat.apiKey : driverCtx?.resolveEnv(seat.apiKey);
    if (resolved !== undefined && resolved.length > 0) {
      headers['authorization'] = `Bearer ${resolved}`;
      return Object.freeze<OpenAiSeatAuth>({
        seatId: seat.id,
        authSource: 'api-key',
        headers: Object.freeze(headers),
      });
    }
  }
  if (seat?.configDir !== undefined) {
    headers['authorization'] = `Bearer codex-oauth:${seat.id}:${seat.configDir}`;
    return Object.freeze<OpenAiSeatAuth>({
      seatId: seat.id,
      authSource: 'cli-oauth',
      headers: Object.freeze(headers),
    });
  }
  return Object.freeze<OpenAiSeatAuth>({
    seatId: seat?.id,
    authSource: 'none',
    headers: Object.freeze(headers),
  });
}
