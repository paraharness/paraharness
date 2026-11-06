import type { SkillNode } from '@harness-dsl/core';
import { createMdFrontmatterBuilder } from './create-md-frontmatter-builder.js';
import type { MdFrontmatterSourceBuilder } from './md-frontmatter-source-builder.js';

/**
 * Builds a `MdFrontmatterSourceBuilder<SkillNode<THandle>>` for `md.skill(path)`.
 *
 * Configures `kind: 'skill'` and `id: "md:skill:${path}"` for passing into `H.skill(md.skill(path))`
 * while binding code-level `.unlocksTools(...)` and `.unlocksServices(...)`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {string} path - Host-root-relative path to a single skill Markdown file.
 *
 * @returns {MdFrontmatterSourceBuilder<SkillNode<THandle>>} Frozen single skill source builder.
 */
export function createMdSkillBuilder<THandle = unknown>(
  path: string,
): MdFrontmatterSourceBuilder<SkillNode<THandle>> {
  return createMdFrontmatterBuilder<SkillNode<THandle>>(path, 'skill');
}
