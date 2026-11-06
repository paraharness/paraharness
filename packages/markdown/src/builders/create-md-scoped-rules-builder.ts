import type { ScopedRule } from '@harness-dsl/core';
import { createMdFrontmatterBuilder } from './create-md-frontmatter-builder.js';
import type { MdFrontmatterSourceBuilder } from './md-frontmatter-source-builder.js';

/**
 * Builds a `MdFrontmatterSourceBuilder<readonly ScopedRule[]>` for `md.scopedRules(glob)`.
 *
 * Configures `kind: 'scoped-rules'` and `id: "md:scoped-rules:${glob}"` so all matching Markdown files
 * are parsed and their frontmatter `globs` translated into passive `FsGlobMatcherNode` descriptors.
 *
 * @param {string} glob - Host-root-relative glob pattern targeting scoped rule Markdown files.
 *
 * @returns {MdFrontmatterSourceBuilder<readonly ScopedRule[]>} Frozen scoped rules array source builder.
 */
export function createMdScopedRulesBuilder(
  glob: string,
): MdFrontmatterSourceBuilder<readonly ScopedRule[]> {
  return createMdFrontmatterBuilder<readonly ScopedRule[]>(glob, 'scoped-rules');
}
