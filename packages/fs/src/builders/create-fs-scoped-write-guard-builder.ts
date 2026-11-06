import type { FsPartitionMapNode, FsScopedWriteGuardNode } from '@harness-dsl/core';

/**
 * Compiles a passive `FsScopedWriteGuardNode` (`fs:scoped-write`) for `fs.scopedWrite(partitionMap)`.
 *
 * Restricts write mutations strictly to the union of member `globs` for the actor's
 * `activePartitions` in `partitionMap`.
 *
 * @template TPartition Literal union of partition identifiers in `partitionMap`.
 *
 * @param {FsPartitionMapNode<TPartition>} partitionMap - Filesystem partition map AST node.
 *
 * @returns {FsScopedWriteGuardNode} Deeply frozen `FsScopedWriteGuardNode` AST descriptor.
 */
export function createFsScopedWriteGuardBuilder<TPartition extends string = string>(
  partitionMap: FsPartitionMapNode<TPartition>,
): FsScopedWriteGuardNode {
  return Object.freeze<FsScopedWriteGuardNode>({
    type: 'fs:scoped-write',
    id: `fs:scoped-write:${partitionMap.topology.id}`,
    partitionMap: partitionMap as FsPartitionMapNode<string>,
  });
}
