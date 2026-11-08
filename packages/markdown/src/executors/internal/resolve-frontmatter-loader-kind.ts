import type { MarkdownFrontmatterSourceNode } from '@metaharness/core';

/**
 * Infers the effective loader `kind` from `node.kind` or `node.id` prefix.
 *
 * Ensures deterministic dispatch even if a `MarkdownFrontmatterSourceNode` was constructed with only `id`.
 *
 * @param {MarkdownFrontmatterSourceNode<unknown>} node - Frontmatter source AST node.
 *
 * @returns {NonNullable<MarkdownFrontmatterSourceNode<unknown>['kind']>} Resolved loader kind discriminant.
 */
export function resolveFrontmatterLoaderKind(
  node: MarkdownFrontmatterSourceNode<unknown>,
): NonNullable<MarkdownFrontmatterSourceNode<unknown>['kind']> {
  if (node.kind !== undefined) return node.kind;
  const prefixes: ReadonlyArray<NonNullable<MarkdownFrontmatterSourceNode<unknown>['kind']>> = [
    'global-rules',
    'scoped-rules',
    'scoped-rule',
    'skills',
    'skill',
    'frontmatter',
  ];
  for (const candidate of prefixes) {
    if (node.id.startsWith(`md:${candidate}:`)) return candidate;
  }
  return 'frontmatter';
}
