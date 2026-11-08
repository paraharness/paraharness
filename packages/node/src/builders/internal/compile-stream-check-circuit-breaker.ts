import type { LocalStreamCheckCircuitBreakerConfig } from '@metaharness/core';
import type { LocalStreamCheckCircuitBreakerOptions } from '../local-stream-check-builder.js';

/**
 * Validates and compiles a `LocalStreamCheckCircuitBreakerConfig` from `pattern` and `options`.
 *
 * Ensures `graceLinesAfterMatch` is a non-negative integer and extracts regex pattern and flags.
 *
 * @param {string}                                id      - Streaming check identifier for error diagnostics.
 * @param {RegExp | string}                       pattern - Regular expression or pattern string to match.
 * @param {LocalStreamCheckCircuitBreakerOptions} options - Trailing grace line capture configuration.
 *
 * @returns {LocalStreamCheckCircuitBreakerConfig} Frozen circuit-breaker AST configuration.
 *
 * @throws {Error} If `options.graceLinesAfterMatch` is not a non-negative integer.
 */
export function compileStreamCheckCircuitBreaker(
  id: string,
  pattern: RegExp | string,
  options: LocalStreamCheckCircuitBreakerOptions,
): LocalStreamCheckCircuitBreakerConfig {
  if (!Number.isInteger(options.graceLinesAfterMatch) || options.graceLinesAfterMatch < 0) {
    throw new Error(
      `local.streamCheck('${id}').circuitBreakWhenStdout requires non-negative integer graceLinesAfterMatch.`,
    );
  }
  const source = typeof pattern === 'string' ? pattern : pattern.source;
  const flags =
    typeof pattern === 'string' || pattern.flags.length === 0 ? undefined : pattern.flags;
  return Object.freeze<LocalStreamCheckCircuitBreakerConfig>({
    pattern: source,
    flags,
    graceLinesAfterMatch: options.graceLinesAfterMatch,
  });
}
