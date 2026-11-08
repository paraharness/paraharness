import type { FsQuotaTripwireNode } from '@metaharness/core';

/**
 * Compiles a passive `FsQuotaTripwireNode` (`fs:quota-tripwire`) for `fs.maxFilesMutated(count)`.
 *
 * Trips `PolicyNode.onLimitExceeded` when the number of distinct mutated file paths in
 * a step session exceeds `count`.
 *
 * @param {number} count - Maximum number of distinct mutated files allowed before tripping.
 *
 * @returns {FsQuotaTripwireNode} Deeply frozen `FsQuotaTripwireNode` AST descriptor.
 */
export function createFsMaxFilesMutatedBuilder(count: number): FsQuotaTripwireNode {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`fs.maxFilesMutated requires a non-negative integer count (received ${String(count)}).`);
  }
  return Object.freeze<FsQuotaTripwireNode>({
    type: 'fs:quota-tripwire',
    id: `fs:max-files-mutated:${String(count)}`,
    maxFilesMutated: count,
  });
}
