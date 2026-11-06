import type { BaseSourceASTNode } from '../base/base-source-ast-node.js';

/**
 * Passive AST node loading UTF-8 text from a single file path (`fs.text`).
 *
 * Resolved against the immutable host repository root for control-plane definitions and
 * initial prefix compilation, or against `ResolutionContext.scopeHandle` when computing
 * in-run grounding diffs.
 */
export interface FsTextSourceNode extends BaseSourceASTNode<'fs:text-source', string> {
  /** Repository-relative path to the UTF-8 text file. */
  readonly path: string;
}
