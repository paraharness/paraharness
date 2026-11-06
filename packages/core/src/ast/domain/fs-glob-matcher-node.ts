import type { BaseEffectMatcherASTNode } from '../base/base-effect-matcher-ast-node.js';

/**
 * Passive AST node matching `FsToolEffect` paths against POSIX glob patterns (`fs.matchGlobs`).
 *
 * Used inside `ScopePredicate.effects` and `LeaseDelta.allowEffects` to match `'read'`, `'write'`,
 * or `'any'` filesystem effects against normalized repository-relative paths.
 */
export interface FsGlobMatcherNode extends BaseEffectMatcherASTNode<'fs:match-globs'> {
  /** Glob patterns or exact normalized file paths matched by this descriptor. */
  readonly globs: readonly string[];
  /** Access mode filter (`'read' | 'write' | 'any'`). */
  readonly mode: 'read' | 'write' | 'any';
}
