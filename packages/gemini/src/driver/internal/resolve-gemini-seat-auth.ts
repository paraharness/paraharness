import type {
  GeminiAccountSeatNode,
  GeminiModelNode,
  RuntimeDriverContext,
} from '@paraharness/core';
import type { GeminiSeatAuth } from './gemini-seat-auth.js';

/**
 * Parameters for resolving Google Gemini seat authentication via `resolveGeminiSeatAuth()`.
 *
 * Combines the turn-level `accountConfig`, bound `modelNode`, and optional `driverCtx`.
 */
export interface ResolveGeminiSeatAuthParams {
  /** Optional seat configuration supplied on `ModelTurnRequest.accountConfig`. */
  readonly accountConfig: unknown;
  /** Optional passive `GeminiModelNode` bound to the driver instance. */
  readonly modelNode: GeminiModelNode | undefined;
  /** Optional runtime driver context providing `resolveEnv` for symbolic `EnvRef` keys. */
  readonly driverCtx: RuntimeDriverContext | undefined;
}

/**
 * Resolves Google Gemini authentication headers and active seat metadata for a single turn invocation.
 *
 * Evaluates symbolic `EnvRef` API keys (`x-goog-api-key`) via `driverCtx.resolveEnv` or CLI/ADC `configDir` OAuth tokens.
 *
 * @param {ResolveGeminiSeatAuthParams} params - Account config, bound model node, and runtime driver context.
 *
 * @returns {GeminiSeatAuth} Resolved `seatId`, `authSource`, and HTTP `headers`.
 */
export function resolveGeminiSeatAuth(params: ResolveGeminiSeatAuthParams): GeminiSeatAuth {
  const { accountConfig, modelNode, driverCtx } = params;
  const pool = modelNode?.accountPool;
  const seat = (accountConfig ?? pool?.items[0] ?? pool?.fallbackItem) as
    | GeminiAccountSeatNode
    | undefined;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (seat?.apiKey !== undefined) {
    const resolved =
      typeof seat.apiKey === 'string' ? seat.apiKey : driverCtx?.resolveEnv(seat.apiKey);
    if (resolved !== undefined && resolved.length > 0) {
      headers['x-goog-api-key'] = resolved;
      return Object.freeze<GeminiSeatAuth>({
        seatId: seat.id,
        authSource: 'api-key',
        headers: Object.freeze(headers),
      });
    }
  }
  if (seat?.configDir !== undefined) {
    headers['authorization'] = `Bearer gemini-oauth:${seat.id}:${seat.configDir}`;
    return Object.freeze<GeminiSeatAuth>({
      seatId: seat.id,
      authSource: 'cli-oauth',
      headers: Object.freeze(headers),
    });
  }
  return Object.freeze<GeminiSeatAuth>({
    seatId: seat?.id,
    authSource: 'none',
    headers: Object.freeze(headers),
  });
}
