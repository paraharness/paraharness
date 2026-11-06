import type { TopologyPartitionConstraint } from '../../ast/topology-node.js';
import type { TopologyDfsContext } from './topology-dfs-context.js';
import {
  assertValidPartitionDependencies,
  buildReverseAdjacencyMap,
  isPartitionKey,
  visitPartitionDfs,
} from './topology-dfs-helpers.js';

/**
 * Validates that a topology's partition map has non-empty partition IDs, valid `dependsOn` references, and zero directed cycles.
 *
 * Uses a 3-state DFS (`'unvisited'`, `'visiting'`, `'visited'`) to reject self-loops and multi-node cycles at AST build time.
 *
 * @template TPartition Literal string union of partition identifiers.
 *
 * @param {string}                                                                topologyId - Unique identifier of the topology.
 * @param {Readonly<Record<TPartition, TopologyPartitionConstraint<TPartition>>>} partitions - Partition dependency map to validate.
 *
 * @throws {Error} If `partitions` is empty, contains an empty partition ID, references an unknown partition, or contains a cycle.
 */
export function validateTopologyDAG<TPartition extends string>(
  topologyId: string,
  partitions: Readonly<Record<TPartition, TopologyPartitionConstraint<TPartition>>>,
): void {
  const rawKeys = Object.keys(partitions);
  if (rawKeys.length === 0) {
    throw new Error(`Topology '${topologyId}' must declare at least one partition.`);
  }
  const knownKeys = new Set<string>();
  const depsByKey = new Map<string, readonly string[]>();
  const stateByKey = new Map<string, 'unvisited' | 'visiting' | 'visited'>();
  for (const key of rawKeys) {
    if (!isPartitionKey(partitions, key)) continue;
    if (key.trim().length === 0) {
      throw new Error(`Topology '${topologyId}' contains an empty partition identifier.`);
    }
    knownKeys.add(key);
    depsByKey.set(key, partitions[key].dependsOn ?? []);
    stateByKey.set(key, 'unvisited');
  }
  const ctx: TopologyDfsContext = { topologyId, knownKeys, depsByKey, stateByKey, trail: [] };
  for (const key of knownKeys) assertValidPartitionDependencies(ctx, key);
  for (const key of knownKeys) {
    if (stateByKey.get(key) === 'unvisited') visitPartitionDfs(ctx, key);
  }
}

/**
 * Computes all strict transitive dependent partitions of `partitionId` in deterministic topological BFS order.
 *
 * Traverses the reverse dependency graph starting from `partitionId` without including `partitionId` itself in the result.
 *
 * @template TPartition Literal string union of partition identifiers.
 *
 * @param {string}                                                                topologyId  - Identifier of the topology.
 * @param {Readonly<Record<TPartition, TopologyPartitionConstraint<TPartition>>>} partitions  - Validated partition dependency map.
 * @param {TPartition}                                                            partitionId - Source partition identifier to query.
 *
 * @returns {readonly TPartition[]} Frozen array of strict transitive dependent partition identifiers.
 *
 * @throws {Error} If `partitionId` is not a declared partition in `partitions`.
 */
export function computeTransitiveDependents<TPartition extends string>(
  topologyId: string,
  partitions: Readonly<Record<TPartition, TopologyPartitionConstraint<TPartition>>>,
  partitionId: TPartition,
): readonly TPartition[] {
  const reverseAdj = buildReverseAdjacencyMap(topologyId, partitions, partitionId);
  const visited = new Set<TPartition>();
  const queue: TPartition[] = [partitionId];
  const dependents: TPartition[] = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const nextKey of reverseAdj.get(current) ?? []) {
      if (!visited.has(nextKey)) {
        visited.add(nextKey);
        dependents.push(nextKey);
        queue.push(nextKey);
      }
    }
  }
  return Object.freeze(dependents);
}
