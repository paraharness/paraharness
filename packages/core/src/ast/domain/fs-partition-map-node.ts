import type { TopologyNode } from '../topology-node.js';

/**
 * Passive AST node mapping logical `TopologyNode` partitions to physical filesystem globs (`fs.partitionMap`).
 *
 * Associates each partition identifier with its member implementation globs (`globs`) and
 * protected public boundary surface globs (`boundaryGlobs`).
 *
 * @template TPartition Union of partition identifiers in `topology`.
 */
export interface FsPartitionMapNode<TPartition extends string = string> {
  /** Discriminant identifying a filesystem partition map node. */
  readonly type: 'fs:partition-map';
  /** Underlying relational topology graph node. */
  readonly topology: TopologyNode<TPartition>;
  /** Per-partition member glob and boundary glob mapping. */
  readonly mapping: Readonly<
    Record<
      TPartition,
      { readonly globs: readonly string[]; readonly boundaryGlobs: readonly string[] }
    >
  >;
}
