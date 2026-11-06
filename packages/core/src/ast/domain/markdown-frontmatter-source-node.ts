import type { BaseSourceASTNode } from '../base/base-source-ast-node.js';

/**
 * Passive AST node loading frontmatter-annotated rules or skills from Markdown files (`md.*`).
 *
 * Always resolves control-plane rule and skill paths against the immutable host repository root.
 *
 * @template T Resolved rule or skill payload type.
 */
export interface MarkdownFrontmatterSourceNode<T = unknown>
  extends BaseSourceASTNode<'markdown:frontmatter', T> {
  /** File path or glob pattern targeting Markdown documents with YAML frontmatter. */
  readonly pathOrGlob: string;
  /** Optional loader kind discriminant distinguishing rules and skills. */
  readonly kind?:
    | 'global-rules'
    | 'scoped-rule'
    | 'scoped-rules'
    | 'skill'
    | 'skills'
    | 'frontmatter';
}
