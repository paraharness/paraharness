import { MemoryHarnessError } from '../memory-harness-error.js';

/**
 * Validates that `role` is a non-empty string present in `allowedRoles`, throwing a structured
 * `MemoryHarnessError` with code `'INVALID_ROLE'` when disallowed (§6.2–§6.6, §7.2).
 *
 * @param {string}            role               - Candidate role name to validate.
 * @param {readonly string[]} allowedRoles       - Configured list of allowed roles from `config.allowedRoles`.
 * @param {string}            [fieldName='role'] - Input property name for diagnostic attribution.
 *
 * @returns {void}
 *
 * @throws {MemoryHarnessError} With `'INVALID_ROLE'` if `role` is not in `allowedRoles`.
 */
export function assertAllowedRole(
  role: string,
  allowedRoles: readonly string[],
  fieldName = 'role',
): void {
  if (typeof role !== 'string' || !allowedRoles.includes(role)) {
    throw new MemoryHarnessError(
      'INVALID_ROLE',
      `Invalid ${fieldName} '${String(role)}': must be one of allowedRoles (${allowedRoles.join(', ')}).`,
      {
        [fieldName]: role,
        allowedRoles,
      },
    );
  }
}
