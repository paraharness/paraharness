import type { ScopedRule } from '@metaharness/core';
import { createMdFrontmatterBuilder } from './create-md-frontmatter-builder.js';
import type { MdFrontmatterSourceBuilder } from './md-frontmatter-source-builder.js';

/**
 * Builds a `MdFrontmatterSourceBuilder<ScopedRule>` for `md.scopedRule(path)`.
 *
 * Configures `kind: 'scoped-rule'` and `id: "md:scoped-rule:${path}"` so a single Markdown rule file
 * can be passed into `M.scopedRule(md.scopedRule(path))` or `.scoped(...)` and validated with `ScopedRuleSchema`.
 *
 * @param {string} path - Host-root-relative path to a single scoped rule Markdown file.
 *
 * @returns {MdFrontmatterSourceBuilder<ScopedRule>} Frozen single scoped rule source builder.
 */
export function createMdScopedRuleBuilder(path: string): MdFrontmatterSourceBuilder<ScopedRule> {
  return createMdFrontmatterBuilder<ScopedRule>(path, 'scoped-rule');
}
