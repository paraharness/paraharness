import type { AstBuilder, MarkdownFrontmatterSourceNode } from '@metaharness/core';

/**
 * Fluent builder and passive AST descriptor for Markdown frontmatter sources (`md.*`).
 *
 * Satisfies both `MarkdownFrontmatterSourceNode<T>` directly and `AstBuilder<MarkdownFrontmatterSourceNode<T>>`
 * so `extractAST` produces a pure passive `MarkdownFrontmatterSourceNode<T>` record without methods.
 *
 * @template T Resolved rule, skill, or frontmatter payload type.
 */
export interface MdFrontmatterSourceBuilder<T = unknown>
  extends MarkdownFrontmatterSourceNode<T>,
    AstBuilder<MarkdownFrontmatterSourceNode<T>> {
  /**
   * Compiles this builder into a pure, JSON-serializable `MarkdownFrontmatterSourceNode<T>`.
   *
   * Strips the builder method wrapper while preserving `type`, `id`, `pathOrGlob`, and `kind`.
   *
   * @returns {MarkdownFrontmatterSourceNode<T>} Frozen passive `MarkdownFrontmatterSourceNode<T>`.
   */
  toAST(): MarkdownFrontmatterSourceNode<T>;
}
