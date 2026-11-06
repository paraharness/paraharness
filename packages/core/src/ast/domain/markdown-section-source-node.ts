import type { BaseSourceASTNode } from '../base/base-source-ast-node.js';

/**
 * Passive AST node extracting a specific Markdown heading section from a document (`md.section`).
 *
 * Parses the Markdown document at `path` relative to the host repository root and extracts the
 * text under `heading` up to the next heading of equal or higher depth.
 *
 * @template T Resolved section content type.
 */
export interface MarkdownSectionSourceNode<T = unknown>
  extends BaseSourceASTNode<'markdown:section', T> {
  /** Host-root-relative path to the Markdown file. */
  readonly path: string;
  /** Target heading title to extract. */
  readonly heading: string;
}
