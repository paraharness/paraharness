import type { BaseCheckASTNode } from '../base/base-check-ast-node.js';

/**
 * Passive AST node evaluating a forbidden regex pattern across mutated files matching `targetGlobs` (`fs.regexCheck`).
 *
 * Scans mutated files during `beforeStop` or scoped rule verification and reports `violationMessage`
 * in `deficits` whenever `forbidPattern` matches.
 *
 * @template THandle Isolation scope handle type.
 */
export interface FsRegexCheckNode<THandle = unknown>
  extends BaseCheckASTNode<'fs:regex-check', THandle> {
  /** Glob patterns selecting mutated files to scan. */
  readonly targetGlobs: readonly string[];
  /** Regular expression source pattern that fails the check when matched. */
  readonly forbidPattern: string;
  /** Optional regular expression flags. */
  readonly forbidFlags?: string;
  /** Diagnostic message reported in `deficits` when a match is found. */
  readonly violationMessage: string;
}
