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
import type { CreateTopologyBuilderState as CreateTopologyBuilderOptions } from './create-topology-builder-state.js';
import { assertNonEmptyIdentifier, deepFreeze } from './internal/deep-freeze.js';
import type { TopologyCommitOverlayBuilderInput } from './topology-commit-overlay-builder-input.js';
import type { TopologyConfigBuilder as ConfigurableTopologyBuilder } from './topology-config-builder.js';

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
  const ensurePartitions = (): Readonly<Record<TPartition, TopologyPartitionConstraint<TPartition>>> => {
    if (options?.partitions === undefined) {
      throw new Error(`Topology '${id}' is missing required .partitions(...) configuration.`);
    }
    return options.partitions;
  };

  return Object.freeze<ConfigurableTopologyBuilder<TPartition>>({
    id,
    store: (topologyStore: MaybeBuilder<TopologyStoreASTNode>) =>
      createTopologyBuilder<TPartition>(id, { ...options, store: extractAST(topologyStore) }),
    partitions: <TNextPartition extends string>(
      partitionMap: Readonly<Record<TNextPartition, TopologyPartitionConstraint<NoInfer<TNextPartition>>>>,
    ) => {
      validateTopologyDAG(id, partitionMap);
      return createTopologyBuilder<TNextPartition>(id, {
        store: options?.store,
        partitions: deepFreeze(partitionMap),
        commitOverlayWhen: options?.commitOverlayWhen,
      });
    },
    commitOverlayWhen: <TOnSig = unknown, TDiscardSig = unknown>(
      config: TopologyCommitOverlayBuilderInput<TOnSig, TDiscardSig>,
    ) => {
      const normalized = deepFreeze<TopologyCommitOverlayConfig>({
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
      return createTopologyBuilder<TPartition>(id, { ...options, commitOverlayWhen: normalized });
    },
    dependentsOf: (partitionId: TPartition) => computeTransitiveDependents(id, ensurePartitions(), partitionId),
    affectedBy: (partitionId: TPartition) =>
      Object.freeze([partitionId, ...computeTransitiveDependents(id, ensurePartitions(), partitionId)]),
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
