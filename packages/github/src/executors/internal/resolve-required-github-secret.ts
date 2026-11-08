import type { EnvRef } from '@paraharness/core';

/**
 * Resolves a GitHub secret or token string from a literal value or symbolic `EnvRef`.
 *
 * Throws an actionable error if the referenced environment variable is unset or empty.
 *
 * @param {string | EnvRef}                              value      - Literal secret or symbolic `EnvRef`.
 * @param {(val: string | EnvRef) => string | undefined} resolveEnv - Runtime environment resolver callback.
 * @param {string}                                       contextId  - Diagnostic adapter or step identifier.
 *
 * @returns {string} Non-empty resolved secret or token string.
 *
 * @throws {Error} If the resolved secret or token is `undefined` or empty.
 */
export function resolveRequiredGithubSecret(
  value: string | EnvRef,
  resolveEnv: (val: string | EnvRef) => string | undefined,
  contextId: string,
): string {
  const resolved = resolveEnv(value);
  if (resolved === undefined || resolved.length === 0) {
    const keyDesc = typeof value === 'string' ? '<literal>' : value.key;
    throw new Error(
      `Missing required GitHub secret/token '${keyDesc}' while executing '${contextId}'.`,
    );
  }
  return resolved;
}
