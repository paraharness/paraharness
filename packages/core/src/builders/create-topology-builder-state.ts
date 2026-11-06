import type { TopologyStoreASTNode } from '../ast/domain-ast.types.js';
import type {
  TopologyCommitOverlayConfig,
  TopologyPartitionConstraint,
} from '../ast/topology-node.js';

/**
 * Optional copy-on-write state for `createTopologyBuilder`.
 *
 * Holds the bound topology store, validated partition dependency map, and optional
 * overlay commit/discard trigger configuration.
 *
 * @template TPartition Partition identifier string union.
 */
export interface CreateTopologyBuilderState<TPartition extends string = string> {
  /** Bound topology store AST node. */
  readonly store?: TopologyStoreASTNode;
  /** Validated partition dependency map. */
  readonly partitions?: Readonly<Record<TPartition, TopologyPartitionConstraint<TPartition>>>;
  /** Optional overlay commit and discard configuration. */
  readonly commitOverlayWhen?: TopologyCommitOverlayConfig;
}

export type { CreateTopologyBuilderState as CreateTopologyBuilderOptions };
