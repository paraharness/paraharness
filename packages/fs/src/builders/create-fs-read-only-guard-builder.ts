import type { FsReadOnlyGuardNode } from '@harness-dsl/core';

/**
 * Compiles a passive `FsReadOnlyGuardNode` (`fs:read-only`) for `fs.readOnly()`.
 *
 * Rejects all filesystem write mutations across declared and post-flight-diffed tools
 * unless covered by an active capability lease.
 *
 * @returns {FsReadOnlyGuardNode} Deeply frozen `FsReadOnlyGuardNode` AST descriptor.
 */
export function createFsReadOnlyGuardBuilder(): FsReadOnlyGuardNode {
  return Object.freeze<FsReadOnlyGuardNode>({
    type: 'fs:read-only',
    id: 'fs:read-only',
  });
}
