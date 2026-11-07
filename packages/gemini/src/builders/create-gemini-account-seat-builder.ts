import type { EnvRef, GeminiAccountSeatNode } from '@harness-dsl/core';
import type { GeminiAccountSeatBuilder } from './gemini-account-seat-builder.js';

/**
 * Creates an immutable `GeminiAccountSeatBuilder` for a Google Gemini API key seat or CLI/ADC seat.
 *
 * Performs zero filesystem reads or environment variable lookups at builder construction time,
 * deferring credential resolution to `GeminiModelDriver.invokeTurn()`.
 *
 * @param {string}                      id          - Non-empty unique seat identifier.
 * @param {string | undefined}          [configDir] - Optional Gemini CLI/ADC configuration directory path.
 * @param {string | EnvRef | undefined} [apiKey]    - Optional literal API key or symbolic `EnvRef`.
 *
 * @returns {GeminiAccountSeatBuilder} Immutable builder compiling to `GeminiAccountSeatNode`.
 *
 * @throws {Error} If `id` is an empty or whitespace-only string.
 */
export function createGeminiAccountSeatBuilder(
  id: string,
  configDir?: string,
  apiKey?: string | EnvRef,
): GeminiAccountSeatBuilder {
  if (id.trim().length === 0) {
    throw new Error('Gemini account seat id must be a non-empty string.');
  }
  const astNode = Object.freeze<GeminiAccountSeatNode>({
    type: 'gemini:account-seat',
    id,
    configDir,
    apiKey,
  });
  return Object.freeze<GeminiAccountSeatBuilder>({
    id,
    configDir(path: string): GeminiAccountSeatBuilder {
      if (path.trim().length === 0) {
        throw new Error(`Gemini account seat '${id}' configDir must be a non-empty path.`);
      }
      return createGeminiAccountSeatBuilder(id, path, apiKey);
    },
    apiKey(envOrKey: string | EnvRef): GeminiAccountSeatBuilder {
      if (typeof envOrKey === 'string' && envOrKey.trim().length === 0) {
        throw new Error(`Gemini account seat '${id}' apiKey string must be non-empty.`);
      }
      return createGeminiAccountSeatBuilder(id, configDir, envOrKey);
    },
    toAST(): GeminiAccountSeatNode {
      return astNode;
    },
  });
}
