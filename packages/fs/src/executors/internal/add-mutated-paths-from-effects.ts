import type { ToolEffect } from '@harness-dsl/core';

/**
 * Adds normalized mutated file paths from `observedEffects` (`mutatesScope === true` or `mode === 'write'`) into `mutated`.
 *
 * @param {readonly ToolEffect[]} observedEffects - Tool effects recorded in `StepExecutionContext`.
 * @param {Set<string>}           mutated         - Mutable set of normalized POSIX paths to populate.
 */
export function addMutatedPathsFromEffects(
  observedEffects: readonly ToolEffect[],
  mutated: Set<string>,
): void {
  for (const eff of observedEffects) {
    if (eff.kind !== 'fs:effect') continue;
    const mode = eff.attributes?.['mode'];
    if (eff.mutatesScope !== true && mode !== 'write') continue;
    const paths = eff.attributes?.['paths'];
    if (!Array.isArray(paths)) continue;
    for (const relPath of paths) {
      if (typeof relPath === 'string') {
        mutated.add(relPath.replace(/\\/g, '/').replace(/^\.\//, ''));
      }
    }
  }
}
