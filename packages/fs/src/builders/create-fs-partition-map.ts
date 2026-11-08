import {
  extractAST,
  type FsPartitionMapNode,
  type FsPartitionPathMapping,
  type MaybeBuilder,
  type TopologyNode,
} from '@paraharness/core';

/**
 * Compiles a passive `FsPartitionMapNode` (`fs:partition-map`) for `fs.partitionMap(topology, mapping)`.
 *
 * Associates each logical partition in `topology` with its physical implementation globs
 * (`globs`) and protected public boundary surface globs (`boundaryGlobs`).
 *
 * @template TPartition Literal union of partition identifiers in `topology`.
 *
 * @param {MaybeBuilder<TopologyNode<TPartition>>}               topology - Relational topology AST node or builder.
 * @param {Readonly<Record<TPartition, FsPartitionPathMapping>>} mapping  - Per-partition member and boundary globs.
 *
 * @returns {FsPartitionMapNode<TPartition>} Deeply frozen `FsPartitionMapNode` AST descriptor.
 */
export function createFsPartitionMap<TPartition extends string = string>(
  topology: MaybeBuilder<TopologyNode<TPartition>>,
  mapping: Readonly<Record<TPartition, FsPartitionPathMapping>>,
): FsPartitionMapNode<TPartition> {
  const topologyNode = extractAST(topology);
  const frozenMapping = {} as Record<TPartition, FsPartitionPathMapping>;
  for (const partitionKey of Object.keys(topologyNode.partitions) as TPartition[]) {
    const entry = mapping[partitionKey];
    if (entry === undefined) {
      throw new Error(
        `fs.partitionMap missing mapping for partition '${partitionKey}' in topology '${topologyNode.id}'.`,
      );
    }
    frozenMapping[partitionKey] = Object.freeze<FsPartitionPathMapping>({
      globs: Object.freeze([...entry.globs]),
      boundaryGlobs: Object.freeze([...(entry.boundaryGlobs ?? [])]),
    });
  }
  return Object.freeze<FsPartitionMapNode<TPartition>>({
    type: 'fs:partition-map',
    topology: topologyNode,
    mapping: Object.freeze(frozenMapping),
  });
}
