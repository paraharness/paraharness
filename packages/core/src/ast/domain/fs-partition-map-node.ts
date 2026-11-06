import type { TopologyNode } from '../topology-node.js';

/**
 * Member implementation globs and public boundary surface globs mapped to a single topology partition.
 *
 * Defines which files belong to the partition (`globs`) and which exported public contract files
 * (`boundaryGlobs`) trigger downstream partition invalidation when modified.
 */
export interface FsPartitionPathMapping {
  /** Glob patterns matching files owned by this partition. */
  readonly globs: readonly string[];
  /** Glob patterns matching public boundary contract files for this partition. */
  readonly boundaryGlobs: readonly string[];
}

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
  readonly mapping: Readonly<Record<TPartition, FsPartitionPathMapping>>;
}
