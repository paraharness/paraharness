import type { SkillNode } from '@harness-dsl/core';
import { createMdFrontmatterBuilder } from './create-md-frontmatter-builder.js';
import type { MdFrontmatterSourceBuilder } from './md-frontmatter-source-builder.js';

/**
 * Builds a `MdFrontmatterSourceBuilder<readonly SkillNode<THandle>[]>` for `md.skills(glob)`.
 *
 * Configures `kind: 'skills'` and `id: "md:skills:${glob}"` so procedural skills matching `glob`
 * can be mounted directly via `H.agent(...).skills(md.skills(glob))`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {string} glob - Host-root-relative glob pattern targeting skill Markdown files.
 *
 * @returns {MdFrontmatterSourceBuilder<readonly SkillNode<THandle>[]>} Frozen skill bundle source builder.
 */
export function createMdSkillsBuilder<THandle = unknown>(
  glob: string,
): MdFrontmatterSourceBuilder<readonly SkillNode<THandle>[]> {
  return createMdFrontmatterBuilder<readonly SkillNode<THandle>[]>(glob, 'skills');
}
