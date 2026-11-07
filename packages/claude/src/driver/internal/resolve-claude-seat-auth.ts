import type {
  ClaudeAccountSeatNode,
  ClaudeModelNode,
  RuntimeDriverContext,
} from '@harness-dsl/core';
import { ANTHROPIC_API_VERSION } from '../default-claude-http-transport.constants.js';
import type { ClaudeSeatAuth } from './claude-seat-auth.js';
import { extractOAuthTokenFromConfigDir } from './extract-oauth-token-from-config-dir.js';

/**
 * Parameters for resolving Anthropic seat credentials via `resolveClaudeSeatAuth()`.
 *
 * Supplies the turn-level `accountConfig`, the bound `ClaudeModelNode`, and the optional
 * `RuntimeDriverContext` used to resolve symbolic `EnvRef` keys.
 */
export interface ResolveClaudeSeatAuthParams {
  /** Optional seat configuration passed on `ModelTurnRequest.accountConfig`. */
  readonly accountConfig: unknown;
  /** Optional bound `ClaudeModelNode` carrying an `accountPool`. */
  readonly modelNode: ClaudeModelNode | undefined;
  /** Optional runtime driver context providing `resolveEnv`. */
  readonly driverCtx: RuntimeDriverContext | undefined;
}

/**
 * Attempts to resolve OAuth bearer authentication from `candidateSeat.configDir`.
 *
 * Returns `undefined` when `configDir` is absent or when `configDir` is missing on disk and a fallback
 * `apiKey` is configured on either the seat or the model pool's `fallbackItem`.
 *
 * @param {ClaudeAccountSeatNode | undefined} candidateSeat - Active candidate account seat.
 * @param {ClaudeAccountSeatNode | undefined} fallbackSeat  - Pool fallback account seat, if configured.
 *
 * @returns {ClaudeSeatAuth | undefined} Resolved OAuth seat auth, or `undefined` to fall back to `apiKey`.
 */
function tryResolveClaudeOAuthSeat(
  candidateSeat: ClaudeAccountSeatNode | undefined,
  fallbackSeat: ClaudeAccountSeatNode | undefined,
): ClaudeSeatAuth | undefined {
  if (candidateSeat?.configDir === undefined) {
    return undefined;
  }
  const diskToken = extractOAuthTokenFromConfigDir(candidateSeat.configDir);
  if (diskToken !== undefined) {
    return Object.freeze<ClaudeSeatAuth>({
      seatId: candidateSeat.id,
      authSource: 'cli-oauth',
      headers: Object.freeze({
        'content-type': 'application/json',
        'anthropic-version': ANTHROPIC_API_VERSION,
        authorization: `Bearer ${diskToken}`,
      }),
    });
  }
  if (candidateSeat.apiKey !== undefined || fallbackSeat?.apiKey !== undefined) {
    return undefined;
  }
  return Object.freeze<ClaudeSeatAuth>({
    seatId: candidateSeat.id,
    authSource: 'cli-oauth',
    headers: Object.freeze({
      'content-type': 'application/json',
      'anthropic-version': ANTHROPIC_API_VERSION,
      authorization: `Bearer oauth:${candidateSeat.id}:${candidateSeat.configDir}`,
    }),
  });
}

/**
 * Resolves Anthropic authentication headers and seat metadata for a single turn invocation.
 *
 * Prioritizes OAuth credentials extracted from `seat.configDir` and falls back to `seat.apiKey`
 * (or the model pool's fallback seat `apiKey`) resolved via `params.driverCtx?.resolveEnv`.
 *
 * @param {ResolveClaudeSeatAuthParams} params - Seat configuration, model node, and runtime driver context.
 *
 * @returns {ClaudeSeatAuth} Resolved `seatId`, `authSource`, and HTTP `headers`.
 */
export function resolveClaudeSeatAuth(params: ResolveClaudeSeatAuthParams): ClaudeSeatAuth {
  const pool = params.modelNode?.accountPool;
  const candidateSeat = (params.accountConfig ?? pool?.items[0] ?? pool?.fallbackItem) as
    | ClaudeAccountSeatNode
    | undefined;
  const oauthAuth = tryResolveClaudeOAuthSeat(candidateSeat, pool?.fallbackItem);
  if (oauthAuth !== undefined) {
    return oauthAuth;
  }
  const apiKeySeat =
    candidateSeat?.apiKey !== undefined ? candidateSeat : (pool?.fallbackItem ?? candidateSeat);
  const rawKey = apiKeySeat?.apiKey;
  if (rawKey !== undefined) {
    const resolvedKey =
      typeof rawKey === 'string' ? rawKey : params.driverCtx?.resolveEnv(rawKey);
    if (resolvedKey !== undefined && resolvedKey.length > 0) {
      return Object.freeze<ClaudeSeatAuth>({
        seatId: apiKeySeat?.id,
        authSource: 'api-key',
        headers: Object.freeze({
          'content-type': 'application/json',
          'anthropic-version': ANTHROPIC_API_VERSION,
          'x-api-key': resolvedKey,
        }),
      });
    }
  }
  return Object.freeze<ClaudeSeatAuth>({
    seatId: candidateSeat?.id,
    authSource: 'none',
    headers: Object.freeze({
      'content-type': 'application/json',
      'anthropic-version': ANTHROPIC_API_VERSION,
    }),
  });
}
