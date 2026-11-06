import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type { TopologyStoreASTNode } from '../ast/domain-ast.types.js';
import type { TopologyBuilder } from '../ast/topology-builder.js';
import type { TopologyPartitionConstraint } from '../ast/topology-node.js';
import type { TopologyCommitOverlayBuilderInput } from './topology-commit-overlay-builder-input.js';

/**
 * Fluent builder for relational system topologies (`H.topology(id)`), extending `TopologyBuilder<TPartition>`.
 *
 * Binds the backing `TopologyStoreASTNode`, statically validates the partition dependency
 * DAG via `.partitions(...)`, and configures signal-driven overlay commits.
 *
 * @template TPartition Literal string union of partition identifiers in the topology DAG.
 */
export interface TopologyConfigBuilder<TPartition extends string = string>
  extends TopologyBuilder<TPartition> {
  /**
   * Binds the backing `TopologyStoreASTNode` (`sqlite.topologyStore` or `postgres.topologyStore`).
   *
   * Replaces any previously bound store while preserving declared partitions and overlay rules.
   *
   * @param {MaybeBuilder<TopologyStoreASTNode>} topologyStore - Topology store AST node or builder.
   *
   * @returns {TopologyConfigBuilder<TPartition>} New immutable topology builder.
   */
  store(
    topologyStore: MaybeBuilder<TopologyStoreASTNode>,
  ): TopologyConfigBuilder<TPartition>;

  /**
   * Declares and statically validates the directed acyclic graph (DAG) of partitions and their `dependsOn` edges.
   *
   * Verifies at builder call time that `partitionMap` is non-empty, references only known keys, and is acyclic.
   *
   * @template TNextPartition Literal string union of partition keys in `partitionMap`.
   *
   * @param {Readonly<Record<TNextPartition, TopologyPartitionConstraint<NoInfer<TNextPartition>>>>} partitionMap - Partition dependency map.
   *
   * @returns {TopologyConfigBuilder<TNextPartition>} New immutable topology builder narrowed to `TNextPartition`.
   *
   * @throws {Error} If `partitionMap` is empty, references unknown partitions, or contains a dependency cycle.
   */
  partitions<TNextPartition extends string>(
    partitionMap: Readonly<
      Record<TNextPartition, TopologyPartitionConstraint<NoInfer<TNextPartition>>>
    >,
  ): TopologyConfigBuilder<TNextPartition>;

  /**
   * Configures signal-correlated overlay commit and discard triggers for PR-based lanes.
   *
   * Extracts any `SignalBuilder` instances inside `config` into passive `SignalNode` references.
   *
   * @template TOnSig      Commit signal payload type.
   * @template TDiscardSig Discard signal payload type.
   *
   * @param {TopologyCommitOverlayBuilderInput<TOnSig, TDiscardSig>} config - Overlay commit/discard trigger configuration.
   *
   * @returns {TopologyConfigBuilder<TPartition>} New immutable topology builder.
   */
  commitOverlayWhen<TOnSig = unknown, TDiscardSig = unknown>(
    config: TopologyCommitOverlayBuilderInput<TOnSig, TDiscardSig>,
  ): TopologyConfigBuilder<TPartition>;
}
