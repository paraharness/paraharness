import type { FsGlobMatcherNode } from '@paraharness/core';

/**
 * Compiles a passive `FsGlobMatcherNode` (`fs:match-globs`) for `fs.matchGlobs(globs, mode)`.
 *
 * Matches `FsToolEffect` paths against exact normalized file paths and POSIX glob patterns
 * for reactive `when.effects` triggers and capability lease matching.
 *
 * @param {readonly string[]}        globs          - Glob patterns or exact normalized file paths to match.
 * @param {'read' | 'write' | 'any'} [mode='write'] - Access mode filter (`'read' | 'write' | 'any'`).
 *
 * @returns {FsGlobMatcherNode} Deeply frozen `FsGlobMatcherNode` AST descriptor.
 */
export function createFsGlobMatcherBuilder(
  globs: readonly string[],
  mode: 'read' | 'write' | 'any' = 'write',
): FsGlobMatcherNode {
  if (!Array.isArray(globs) || globs.length === 0) {
    throw new Error('fs.matchGlobs requires a non-empty array of glob patterns.');
  }
  const frozenGlobs = Object.freeze([...globs]);
  return Object.freeze<FsGlobMatcherNode>({
    type: 'fs:match-globs',
    id: `fs:match-globs:${mode}:${frozenGlobs.join(',')}`,
    globs: frozenGlobs,
    mode,
  });
}
