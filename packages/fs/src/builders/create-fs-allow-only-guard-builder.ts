import type { FsAllowOnlyGuardNode } from '@harness-dsl/core';

/**
 * Compiles a passive `FsAllowOnlyGuardNode` (`fs:allow-only`) for `fs.allowOnly(globs)`.
 *
 * Restricts filesystem write mutations strictly to paths matching at least one glob
 * in `globs` (or an active `LeaseDelta` grant).
 *
 * @param {readonly string[]} globs - Allowed write glob patterns.
 *
 * @returns {FsAllowOnlyGuardNode} Deeply frozen `FsAllowOnlyGuardNode` AST descriptor.
 */
export function createFsAllowOnlyGuardBuilder(globs: readonly string[]): FsAllowOnlyGuardNode {
  if (!Array.isArray(globs) || globs.length === 0) {
    throw new Error('fs.allowOnly requires a non-empty globs array.');
  }
  const frozenGlobs = Object.freeze([...globs]);
  return Object.freeze<FsAllowOnlyGuardNode>({
    type: 'fs:allow-only',
    id: `fs:allow-only:${frozenGlobs.join(',')}`,
    globs: frozenGlobs,
  });
}
