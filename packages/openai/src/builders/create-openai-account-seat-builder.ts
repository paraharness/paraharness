import type { EnvRef, OpenAiAccountSeatNode } from '@harness-dsl/core';
import type { OpenAiAccountSeatBuilder } from './openai-account-seat-builder.js';

/**
 * Creates an immutable `OpenAiAccountSeatBuilder` for an OpenAI API key seat or Codex CLI seat.
 *
 * Performs zero filesystem reads or environment variable lookups at builder construction time,
 * deferring credential resolution to `OpenAiModelDriver.invokeTurn()`.
 *
 * @param {string}                      id        - Non-empty unique seat identifier.
 * @param {string | undefined}          [configDir] - Optional Codex CLI configuration directory path.
 * @param {string | EnvRef | undefined} [apiKey]    - Optional literal API key or symbolic `EnvRef`.
 *
 * @returns {OpenAiAccountSeatBuilder} Immutable builder compiling to `OpenAiAccountSeatNode`.
 *
 * @throws {Error} If `id` is an empty or whitespace-only string.
 */
export function createOpenAiAccountSeatBuilder(
  id: string,
  configDir?: string,
  apiKey?: string | EnvRef,
): OpenAiAccountSeatBuilder {
  if (id.trim().length === 0) {
    throw new Error('OpenAI account seat id must be a non-empty string.');
  }
  const astNode = Object.freeze<OpenAiAccountSeatNode>({
    type: 'openai:account-seat',
    id,
    configDir,
    apiKey,
  });
  return Object.freeze<OpenAiAccountSeatBuilder>({
    id,
    configDir(path: string): OpenAiAccountSeatBuilder {
      if (path.trim().length === 0) {
        throw new Error(`OpenAI account seat '${id}' configDir must be a non-empty path.`);
      }
      return createOpenAiAccountSeatBuilder(id, path, apiKey);
    },
    apiKey(envOrKey: string | EnvRef): OpenAiAccountSeatBuilder {
      if (typeof envOrKey === 'string' && envOrKey.trim().length === 0) {
        throw new Error(`OpenAI account seat '${id}' apiKey string must be non-empty.`);
      }
      return createOpenAiAccountSeatBuilder(id, configDir, envOrKey);
    },
    toAST(): OpenAiAccountSeatNode {
      return astNode;
    },
  });
}
