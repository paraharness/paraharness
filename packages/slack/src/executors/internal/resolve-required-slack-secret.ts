import type { EnvRef } from '@metaharness/core';

/**
 * Resolves a required Slack credential or channel identifier from a literal string or symbolic `EnvRef`.
 *
 * Throws an actionable error if the referenced environment variable is unset or empty.
 *
 * @param {string | EnvRef}                              value      - Literal value or symbolic `EnvRef`.
 * @param {(val: string | EnvRef) => string | undefined} resolveEnv - Runtime environment resolver callback.
 * @param {string}                                       fieldLabel - Diagnostic field name (`'appToken'`, `'botToken'`, `'channel'`, `'webhookUrl'`).
 *
 * @returns {string} Non-empty resolved string value.
 *
 * @throws {Error} If the resolved secret or channel string is `undefined` or empty.
 */
export function resolveRequiredSlackSecret(
  value: string | EnvRef,
  resolveEnv: (val: string | EnvRef) => string | undefined,
  fieldLabel: string,
): string {
  const resolved = resolveEnv(value);
  if (resolved === undefined || resolved.length === 0) {
    const keyDesc = typeof value === 'string' ? '<literal>' : value.key;
    throw new Error(`Missing required Slack ${fieldLabel} ('${keyDesc}').`);
  }
  return resolved;
}
