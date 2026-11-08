import type { AstBuilder, MarkdownSectionSourceNode } from '@metaharness/core';

/**
 * Fluent builder and passive AST descriptor for Markdown heading section sources (`md.section`).
 *
 * Satisfies both `MarkdownSectionSourceNode<T>` directly and `AstBuilder<MarkdownSectionSourceNode<T>>`
 * so `extractAST` produces a pure passive `MarkdownSectionSourceNode<T>` record without methods.
 *
 * @template T Resolved section content type.
 */
export interface MdSectionSourceBuilder<T = string>
  extends MarkdownSectionSourceNode<T>,
    AstBuilder<MarkdownSectionSourceNode<T>> {
  /**
   * Compiles this builder into a pure, JSON-serializable `MarkdownSectionSourceNode<T>`.
   *
   * Strips the builder method wrapper while preserving `type`, `id`, `path`, and `heading`.
   *
   * @returns {MarkdownSectionSourceNode<T>} Frozen passive `MarkdownSectionSourceNode<T>`.
   */
  toAST(): MarkdownSectionSourceNode<T>;
}
