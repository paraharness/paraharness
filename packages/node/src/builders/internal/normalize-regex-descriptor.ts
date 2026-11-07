import type { LocalDaemonRegexDescriptor } from '../local-daemon-builder.js';

/**
 * Normalizes a `RegExp` or pattern string into a frozen `LocalDaemonRegexDescriptor`.
 *
 * Preserves regex flags only when non-empty so passive AST serialization remains canonical.
 *
 * @param {RegExp | string} pattern - Regular expression instance or source string.
 *
 * @returns {LocalDaemonRegexDescriptor} Frozen serializable regex descriptor.
 */
export function normalizeRegexDescriptor(pattern: RegExp | string): LocalDaemonRegexDescriptor {
  if (typeof pattern === 'string') {
    return Object.freeze<LocalDaemonRegexDescriptor>({ pattern, flags: undefined });
  }
  return Object.freeze<LocalDaemonRegexDescriptor>({
    pattern: pattern.source,
    flags: pattern.flags.length > 0 ? pattern.flags : undefined,
  });
}
