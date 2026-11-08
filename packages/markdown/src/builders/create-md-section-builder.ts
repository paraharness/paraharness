import type { MarkdownSectionSourceNode } from '@paraharness/core';
import type { MdSectionSourceBuilder } from './md-section-source-builder.js';

/**
 * Builds a `MdSectionSourceBuilder<T>` for `md.section(path, heading)`.
 *
 * Sets `id: "md:section:${path}#${heading}"` and compiles to a passive `MarkdownSectionSourceNode<T>`
 * extracting the content under `heading` up to the next heading of equal or higher depth.
 *
 * @template T Resolved section content type.
 *
 * @param {string} path    - Host-root-relative path to the Markdown document.
 * @param {string} heading - Target Markdown heading title to extract.
 *
 * @returns {MdSectionSourceBuilder<T>} Frozen `MdSectionSourceBuilder<T>` instance.
 */
export function createMdSectionBuilder<T = string>(
  path: string,
  heading: string,
): MdSectionSourceBuilder<T> {
  if (path.trim().length === 0 || heading.trim().length === 0) {
    throw new Error('md.section requires non-empty path and heading strings.');
  }
  const id = `md:section:${path}#${heading}`;
  const astNode = Object.freeze<MarkdownSectionSourceNode<T>>({
    type: 'markdown:section',
    id,
    path,
    heading,
  });
  return Object.freeze<MdSectionSourceBuilder<T>>({
    type: 'markdown:section',
    id,
    path,
    heading,
    toAST(): MarkdownSectionSourceNode<T> {
      return astNode;
    },
  });
}
