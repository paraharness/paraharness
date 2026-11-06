import type { ClaudeAccountSeatNode, EnvRef } from '@harness-dsl/core';
import type { ClaudeAccountSeatBuilder } from './claude-account-seat-builder.js';

/**
 * Creates an immutable `ClaudeAccountSeatBuilder` for an Anthropic CLI subscription or API key seat.
 *
 * Performs zero filesystem reads or environment variable lookups at builder construction time,
 * deferring credential extraction to `ClaudeModelDriver.invokeTurn()`.
 *
 * @param {string}                      id        - Non-empty unique seat identifier.
 * @param {string | undefined}          configDir - Optional Claude CLI OAuth configuration directory path.
 * @param {string | EnvRef | undefined} apiKey    - Optional literal API key or symbolic `EnvRef`.
 *
 * @returns {ClaudeAccountSeatBuilder} Immutable builder compiling to `ClaudeAccountSeatNode`.
 */
export function createClaudeAccountSeatBuilder(
  id: string,
  configDir?: string,
  apiKey?: string | EnvRef,
): ClaudeAccountSeatBuilder {
  if (id.trim().length === 0) {
    throw new Error('Claude account seat id must be a non-empty string.');
  }
  const astNode = Object.freeze<ClaudeAccountSeatNode>({
    type: 'claude:account-seat',
    id,
    configDir,
    apiKey,
  });
  return Object.freeze<ClaudeAccountSeatBuilder>({
    id,
    configDir(path: string): ClaudeAccountSeatBuilder {
      if (path.trim().length === 0) {
        throw new Error(`Claude account seat '${id}' configDir must be a non-empty path.`);
      }
      return createClaudeAccountSeatBuilder(id, path, apiKey);
    },
    apiKey(envOrKey: string | EnvRef): ClaudeAccountSeatBuilder {
      if (typeof envOrKey === 'string' && envOrKey.trim().length === 0) {
        throw new Error(`Claude account seat '${id}' apiKey string must be non-empty.`);
      }
      return createClaudeAccountSeatBuilder(id, configDir, envOrKey);
    },
    toAST(): ClaudeAccountSeatNode {
      return astNode;
    },
  });
}
