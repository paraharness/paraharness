import type { FsGlobMatcherNode, ScopePredicate } from '@harness-dsl/core';

/**
 * Translates YAML frontmatter `partitions` and `globs` into a passive `ScopePredicate` record.
 *
 * Emits a passive `FsGlobMatcherNode` (`type: 'fs:match-globs'`, `mode: 'write'`) with a deterministic `id`
 * whenever frontmatter `globs` is non-empty without importing `@harness-dsl/fs`.
 *
 * @param {Readonly<Record<string, unknown>>} frontmatter - Parsed YAML frontmatter key-value record.
 *
 * @returns {ScopePredicate} Frozen `ScopePredicate` with `partitions` and optional `effects`.
 */
export function buildScopePredicateFromFrontmatter(
  frontmatter: Readonly<Record<string, unknown>>,
): ScopePredicate {
  const rawPartitions = frontmatter['partitions'];
  const partitions: string[] = [];
  if (Array.isArray(rawPartitions)) {
    for (const rawEntry of rawPartitions) {
      if (typeof rawEntry === 'string') partitions.push(rawEntry);
    }
  }
  const rawGlobs = frontmatter['globs'];
  const globs: string[] = [];
  if (Array.isArray(rawGlobs)) {
    for (const rawEntry of rawGlobs) {
      if (typeof rawEntry === 'string') globs.push(rawEntry);
    }
  }
  if (globs.length === 0) {
    return Object.freeze<ScopePredicate>({ partitions, effects: undefined });
  }
  const effectsNode = Object.freeze<FsGlobMatcherNode>({
    type: 'fs:match-globs',
    id: `fs:match-globs:write:${globs.join(',')}`,
    globs: Object.freeze(globs),
    mode: 'write',
  });
  return Object.freeze<ScopePredicate>({ partitions, effects: effectsNode });
}
