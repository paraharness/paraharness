import type { AstBuilder } from './ast-builder.js';
import type { TopologyNode } from './topology-node.js';

/**
 * Fluent builder and query surface for relational partition topologies (`H.topology(id)`).
 *
 * Compiles to a passive `TopologyNode<TPartition>` and exposes `dependentsOf` and `affectedBy`
 * directly on the builder for ergonomic partition impact queries.
 *
 * @template TPartition Literal string union of partition identifiers in the topology DAG.
 */
export interface TopologyBuilder<TPartition extends string = string>
  extends AstBuilder<TopologyNode<TPartition>> {
  /** Unique identifier of the relational topology. */
  readonly id: string;

  /**
   * Returns all strict transitive dependent partitions that depend (directly or indirectly) on `partitionId`.
   *
   * Traverses the reverse dependency edges of the topology DAG in deterministic topological order,
   * excluding `partitionId` itself from the returned array.
   *
   * @param {TPartition} partitionId - Source partition identifier in the topology DAG.
   *
   * @returns {readonly TPartition[]} Deterministically ordered list of strict transitive dependent partitions.
   */
  dependentsOf(partitionId: TPartition): readonly TPartition[];

  /**
   * Returns `[partitionId, ...dependentsOf(partitionId)]`, representing all partitions affected by a contract change in `partitionId`.
   *
   * Places `partitionId` first followed by all strict transitive dependents in deterministic
   * topological order so scoped rules and cross-verifiers can inspect the full impact cone.
   *
   * @param {TPartition} partitionId - Source partition identifier in the topology DAG.
   *
   * @returns {readonly TPartition[]} `partitionId` followed by its strict transitive dependents.
   */
  affectedBy(partitionId: TPartition): readonly TPartition[];
}
