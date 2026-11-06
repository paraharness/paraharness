import type { FsRequireReadBeforeWriteGuardNode } from '@harness-dsl/core';

/**
 * Compiles a passive `FsRequireReadBeforeWriteGuardNode` (`fs:require-read-before-write`) for `fs.requireReadBeforeWrite()`.
 *
 * Rejects mutating any file that already existed at `baseRef` unless `observedEffects`
 * contains a prior read effect for that path in the active session.
 *
 * @returns {FsRequireReadBeforeWriteGuardNode} Deeply frozen `FsRequireReadBeforeWriteGuardNode` AST descriptor.
 */
export function createFsRequireReadBeforeWriteGuardBuilder(): FsRequireReadBeforeWriteGuardNode {
  return Object.freeze<FsRequireReadBeforeWriteGuardNode>({
    type: 'fs:require-read-before-write',
    id: 'fs:require-read-before-write',
  });
}
