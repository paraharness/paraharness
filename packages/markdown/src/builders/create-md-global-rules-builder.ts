import type { GlobalRule } from '@harness-dsl/core';
import { createMdFrontmatterBuilder } from './create-md-frontmatter-builder.js';
import type { MdFrontmatterSourceBuilder } from './md-frontmatter-source-builder.js';

/**
 * Builds a `MdFrontmatterSourceBuilder<readonly GlobalRule[]>` for `md.globalRules(glob)`.
 *
 * Configures `kind: 'global-rules'` and `id: "md:global-rules:${glob}"` so matched Markdown files
 * are parsed and validated against `GlobalRuleSchema` relative to the host repository root.
 *
 * @param {string} glob - Host-root-relative file path or glob pattern targeting global rule Markdown files.
 *
 * @returns {MdFrontmatterSourceBuilder<readonly GlobalRule[]>} Frozen global rules source builder.
 */
export function createMdGlobalRulesBuilder(
  glob: string,
): MdFrontmatterSourceBuilder<readonly GlobalRule[]> {
  return createMdFrontmatterBuilder<readonly GlobalRule[]>(glob, 'global-rules');
}
