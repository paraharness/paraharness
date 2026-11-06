import type { BaseSourceASTNode } from '../base/base-source-ast-node.js';

/**
 * Passive AST node loading multiple UTF-8 text files matching a glob pattern (`fs.glob`).
 *
 * Resolves all matching files in deterministic lexicographical path order and returns their
 * relative paths and UTF-8 contents.
 */
export interface FsGlobSourceNode
  extends BaseSourceASTNode<
    'fs:glob-source',
    ReadonlyArray<{ readonly path: string; readonly content: string }>
  > {
  /** Glob pattern matched against the repository root. */
  readonly pattern: string;
}
