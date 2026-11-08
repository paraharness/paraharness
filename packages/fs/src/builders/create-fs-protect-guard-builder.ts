import type { FsProtectGuardNode } from '@metaharness/core';

/**
 * Compiles a passive `FsProtectGuardNode` (`fs:protect`) for `fs.protect(globs)`.
 *
 * Blocks any write mutation targeting files matching `globs` unless covered by an
 * explicitly elevated capability lease.
 *
 * @param {readonly string[]} globs - Protected file glob patterns.
 *
 * @returns {FsProtectGuardNode} Deeply frozen `FsProtectGuardNode` AST descriptor.
 */
export function createFsProtectGuardBuilder(globs: readonly string[]): FsProtectGuardNode {
  if (!Array.isArray(globs) || globs.length === 0) {
    throw new Error('fs.protect requires a non-empty globs array.');
  }
  const frozenGlobs = Object.freeze([...globs]);
  return Object.freeze<FsProtectGuardNode>({
    type: 'fs:protect',
    id: `fs:protect:${frozenGlobs.join(',')}`,
    globs: frozenGlobs,
  });
}
