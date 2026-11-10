import type { PolicyViolation } from '@paraharness/core';

/**
 * Extracts deduplicated filesystem paths in first-seen order from a `PolicyViolation` (`fs.violatedPaths(violation)`).
 *
 * Iterates `violation.violatedEffects` in a single pass, inspecting only `'fs:effect'` records whose
 * `attributes.paths` property is an array, and collects unique string path entries without allocating
 * intermediate arrays.
 *
 * @param {PolicyViolation} violation - Policy violation emitted by a pre-flight or post-flight policy guard.
 *
 * @returns {string[]} Deduplicated array of violated filesystem paths in first-seen order.
 */
export function extractFsViolatedPaths(violation: PolicyViolation): string[] {
  const seenPaths = new Set<string>();
  const paths: string[] = [];
  for (const effect of violation.violatedEffects) {
    if (effect.kind !== 'fs:effect') continue;
    const rawPaths = effect.attributes?.['paths'];
    if (!Array.isArray(rawPaths)) continue;
    for (const candidatePath of rawPaths) {
      if (typeof candidatePath === 'string' && !seenPaths.has(candidatePath)) {
        seenPaths.add(candidatePath);
        paths.push(candidatePath);
      }
    }
  }
  return paths;
}
