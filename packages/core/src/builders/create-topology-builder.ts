import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type { TopologyStoreASTNode } from '../ast/domain-ast.types.js';
import { extractAST } from '../ast/extract-ast.js';
import type {
  TopologyCommitOverlayConfig,
  TopologyNode,
  TopologyPartitionConstraint,
} from '../ast/topology-node.js';
import {
  computeTransitiveDependents,
  validateTopologyDAG,
} from '../topology/internal/validate-topology-dag.js';
import type { CreateTopologyBuilderOptions } from './create-topology-builder-state.js';
import { assertNonEmptyIdentifier, deepFreeze } from './internal/deep-freeze.js';
import type { TopologyCommitOverlayBuilderInput } from './topology-commit-overlay-builder-input.js';
import type { ConfigurableTopologyBuilder } from './topology-config-builder.js';

/**
 * Creates a fluent `ConfigurableTopologyBuilder` for `H.topology(id)`.
 *
 * Validates the partition dependency DAG at `.partitions(...)` call time and exposes
 * `.dependentsOf(partitionId)` and `.affectedBy(partitionId)` graph queries.
 *
 * @template TPartition Literal string union of partition identifiers.
 *
 * @param {string}                                   id        - Unique identifier of the topology.
 * @param {CreateTopologyBuilderOptions<TPartition>} [options] - Optional internal copy-on-write state.
 *
 * @returns {ConfigurableTopologyBuilder<TPartition>} Frozen topology builder instance.
 */
export function createTopologyBuilder<TPartition extends string = string>(
  id: string,
  options?: CreateTopologyBuilderOptions<TPartition>,
): ConfigurableTopologyBuilder<TPartition> {
  assertNonEmptyIdentifier('H.topology', id);
  const ensurePartitions = (): Readonly<
    Record<TPartition, TopologyPartitionConstraint<TPartition>>
  > => {
    if (options?.partitions === undefined) {
      throw new Error(`Topology '${id}' is missing required .partitions(...) configuration.`);
    }
    return options.partitions;
  };

  return Object.freeze<ConfigurableTopologyBuilder<TPartition>>({
    id,
    store(
      topologyStore: MaybeBuilder<TopologyStoreASTNode>,
    ): ConfigurableTopologyBuilder<TPartition> {
      return createTopologyBuilder<TPartition>(id, {
        ...options,
        store: extractAST(topologyStore),
      });
    },
    partitions<TNextPartition extends string>(
      partitionMap: Readonly<
        Record<TNextPartition, TopologyPartitionConstraint<NoInfer<TNextPartition>>>
      >,
    ): ConfigurableTopologyBuilder<TNextPartition> {
      validateTopologyDAG(id, partitionMap);
      return createTopologyBuilder<TNextPartition>(id, {
        store: options?.store,
        partitions: deepFreeze(partitionMap),
        commitOverlayWhen: options?.commitOverlayWhen,
      });
    },
    commitOverlayWhen<TOnSig = unknown, TDiscardSig = unknown>(
      config: TopologyCommitOverlayBuilderInput<TOnSig, TDiscardSig>,
    ): ConfigurableTopologyBuilder<TPartition> {
      const normalized: TopologyCommitOverlayConfig = deepFreeze<TopologyCommitOverlayConfig>({
        onSignal:
          config.onSignal !== undefined
            ? {
                signal: extractAST(config.onSignal.signal),
                correlateBy: config.onSignal.correlateBy,
                baseBranch: config.onSignal.baseBranch,
              }
            : undefined,
        discardOnSignal:
          config.discardOnSignal !== undefined
            ? {
                signal: extractAST(config.discardOnSignal.signal),
                correlateBy: config.discardOnSignal.correlateBy,
              }
            : undefined,
        maxSealedAgeHours: config.maxSealedAgeHours,
      });
      return createTopologyBuilder<TPartition>(id, {
        ...options,
        commitOverlayWhen: normalized,
      });
    },
    dependentsOf(partitionId: TPartition): readonly TPartition[] {
      return computeTransitiveDependents(id, ensurePartitions(), partitionId);
    },
    affectedBy(partitionId: TPartition): readonly TPartition[] {
      const strictDeps = computeTransitiveDependents(id, ensurePartitions(), partitionId);
      return Object.freeze([partitionId, ...strictDeps]);
    },
    toAST(): TopologyNode<TPartition> {
      if (options?.store === undefined) {
        throw new Error(`Topology '${id}' is missing required .store(...) configuration.`);
      }
      return deepFreeze<TopologyNode<TPartition>>({
        type: 'harness:topology',
        id,
        store: options.store,
        partitions: ensurePartitions(),
        commitOverlayWhen: options.commitOverlayWhen,
      });
    },
  });
}
