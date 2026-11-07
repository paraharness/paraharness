import type { ToolEffect } from '@harness-dsl/core';

/**
 * Collects the set of normalized file paths read across `observedEffects` (`mode === 'read'`).
 *
 * Used by `fs:require-read-before-write` to verify prior read access in the session.
 *
 * @param {readonly ToolEffect[]} observedEffects - Previously observed tool effects in the session.
 *
 * @returns {ReadonlySet<string>} Set of normalized POSIX paths read so far.
 */
export function collectReadPathsFromEffects(
  observedEffects: readonly ToolEffect[],
): ReadonlySet<string> {
  const readPaths = new Set<string>();
  for (const eff of observedEffects) {
    if (eff.kind !== 'fs:effect' || eff.attributes?.['mode'] !== 'read') continue;
    const paths = eff.attributes['paths'];
    if (!Array.isArray(paths)) continue;
    for (const relPath of paths) {
      if (typeof relPath === 'string') {
        readPaths.add(relPath.replace(/\\/g, '/').replace(/^\.\//, ''));
      }
    }
  }
  return readPaths;
}
