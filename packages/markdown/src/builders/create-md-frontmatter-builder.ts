import type { MarkdownFrontmatterSourceNode } from '@metaharness/core';
import type { MdFrontmatterSourceBuilder } from './md-frontmatter-source-builder.js';

/**
 * Builds a `MdFrontmatterSourceBuilder<T>` for `md.frontmatter(pathOrGlob)`.
 *
 * Sets `id: "md:${kind}:${pathOrGlob}"` and `kind` on the passive `MarkdownFrontmatterSourceNode<T>`
 * so `executeMarkdownFrontmatterSource` dispatches deterministically.
 *
 * @template T Resolved frontmatter payload type.
 *
 * @param {string}                                   pathOrGlob - Host-root-relative file path or glob pattern.
 * @param {MarkdownFrontmatterSourceNode<T>['kind']} [kind]     - Optional loader kind discriminant (`'frontmatter'` default).
 *
 * @returns {MdFrontmatterSourceBuilder<T>} Frozen `MdFrontmatterSourceBuilder<T>` instance.
 */
export function createMdFrontmatterBuilder<T = unknown>(
  pathOrGlob: string,
  kind: NonNullable<MarkdownFrontmatterSourceNode<T>['kind']> = 'frontmatter',
): MdFrontmatterSourceBuilder<T> {
  if (pathOrGlob.trim().length === 0) {
    throw new Error(`md.${kind} requires a non-empty pathOrGlob string.`);
  }
  const id = `md:${kind}:${pathOrGlob}`;
  const astNode = Object.freeze<MarkdownFrontmatterSourceNode<T>>({
    type: 'markdown:frontmatter',
    id,
    pathOrGlob,
    kind,
  });
  return Object.freeze<MdFrontmatterSourceBuilder<T>>({
    type: 'markdown:frontmatter',
    id,
    pathOrGlob,
    kind,
    toAST(): MarkdownFrontmatterSourceNode<T> {
      return astNode;
    },
  });
}
