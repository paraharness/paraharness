import type { FsBoundaryGuardNode, FsPartitionMapNode } from '@harness-dsl/core';

/**
 * Compiles a passive `FsBoundaryGuardNode` (`fs:boundary-guard`) for `fs.boundaryGuard(partitionMap)`.
 *
 * Blocks any pre-flight or post-flight write effect matching a partition's `boundaryGlobs`
 * unless covered by an active `LeaseDelta` grant.
 *
 * @template TPartition Literal union of partition identifiers in `partitionMap`.
 *
 * @param {FsPartitionMapNode<TPartition>} partitionMap - Filesystem partition map AST node.
 *
 * @returns {FsBoundaryGuardNode} Deeply frozen `FsBoundaryGuardNode` AST descriptor.
 */
export function createFsBoundaryGuardBuilder<TPartition extends string = string>(
  partitionMap: FsPartitionMapNode<TPartition>,
): FsBoundaryGuardNode {
  return Object.freeze<FsBoundaryGuardNode>({
    type: 'fs:boundary-guard',
    id: `fs:boundary-guard:${partitionMap.topology.id}`,
    partitionMap: partitionMap as FsPartitionMapNode<string>,
  });
}
