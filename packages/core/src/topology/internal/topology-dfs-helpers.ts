import type { TopologyPartitionConstraint } from '../../ast/topology-node.js';
import type { TopologyDfsContext } from './topology-dfs-context.js';

/**
 * Type guard narrowing a string key from `Object.keys(partitions)` to `TPartition`.
 *
 * Ensures prototype properties are excluded when iterating static partition records.
 *
 * @template TPartition Literal string union of partition identifiers.
 *
 * @param {Readonly<Record<TPartition, TopologyPartitionConstraint<TPartition>>>} partitions - Partition map.
 * @param {string}                                                                key        - Candidate key string.
 *
 * @returns {key is TPartition} True when `key` is an own property of `partitions`.
 */
export function isPartitionKey<TPartition extends string>(
  partitions: Readonly<Record<TPartition, TopologyPartitionConstraint<TPartition>>>,
  key: string,
): key is TPartition {
  return Object.prototype.hasOwnProperty.call(partitions, key);
}

/**
 * Validates a single partition's `dependsOn` references against the set of known partition keys.
 *
 * Rejects references to undeclared partitions and immediate self-dependencies before running full cycle detection.
 *
 * @param {TopologyDfsContext} ctx          - Shared topology DFS validation context.
 * @param {string}             partitionKey - Partition key whose dependencies are being checked.
 *
 * @throws {Error} If any dependency key is unknown or references `partitionKey` itself.
 */
export function assertValidPartitionDependencies(ctx: TopologyDfsContext, partitionKey: string): void {
  const dependsOn = ctx.depsByKey.get(partitionKey) ?? [];
  for (const dep of dependsOn) {
    if (!ctx.knownKeys.has(dep)) {
      throw new Error(
        `Topology '${ctx.topologyId}' partition '${partitionKey}' depends on unknown partition '${dep}'.`,
      );
    }
    if (dep === partitionKey) {
      throw new Error(
        `Topology '${ctx.topologyId}' contains a self-dependency cycle on partition '${partitionKey}' (${partitionKey} -> ${partitionKey}).`,
      );
    }
  }
}

/**
 * Performs a 3-state depth-first search from `currentKey` to detect directed cycles in the topology dependency graph.
 *
 * Tracks the active recursion stack in `ctx.trail` so any back-edge to a `'visiting'` node produces a complete cycle path.
 *
 * @param {TopologyDfsContext} ctx        - Shared topology DFS validation context.
 * @param {string}             currentKey - Current partition key being visited.
 *
 * @throws {Error} If a directed cycle is detected.
 */
export function visitPartitionDfs(ctx: TopologyDfsContext, currentKey: string): void {
  ctx.stateByKey.set(currentKey, 'visiting');
  ctx.trail.push(currentKey);
  const dependencies = ctx.depsByKey.get(currentKey) ?? [];
  for (const dep of dependencies) {
    const depState = ctx.stateByKey.get(dep) ?? 'unvisited';
    if (depState === 'visiting') {
      const cycleStartIndex = ctx.trail.indexOf(dep);
      const cyclePath = [...ctx.trail.slice(cycleStartIndex), dep].join(' -> ');
      throw new Error(`Topology '${ctx.topologyId}' contains a dependency cycle: ${cyclePath}.`);
    }
    if (depState === 'unvisited') visitPartitionDfs(ctx, dep);
  }
  ctx.trail.pop();
  ctx.stateByKey.set(currentKey, 'visited');
}

/**
 * Builds a reverse adjacency map mapping each upstream partition to the direct partitions that depend on it.
 *
 * Validates that the queried `partitionId` is declared in `partitions` before populating reverse edges.
 *
 * @template TPartition Literal string union of partition identifiers.
 *
 * @param {string}                                                                topologyId  - Identifier of the topology.
 * @param {Readonly<Record<TPartition, TopologyPartitionConstraint<TPartition>>>} partitions  - Validated partition dependency map.
 * @param {TPartition}                                                            partitionId - Source partition identifier to verify.
 *
 * @returns {Map<TPartition, TPartition[]>} Reverse adjacency map from upstream partition to direct dependents.
 *
 * @throws {Error} If `partitionId` is not a declared partition in `partitions`.
 */
export function buildReverseAdjacencyMap<TPartition extends string>(
  topologyId: string,
  partitions: Readonly<Record<TPartition, TopologyPartitionConstraint<TPartition>>>,
  partitionId: TPartition,
): Map<TPartition, TPartition[]> {
  const partitionKeys: TPartition[] = [];
  const reverseAdj = new Map<TPartition, TPartition[]>();
  for (const rawKey of Object.keys(partitions)) {
    if (!isPartitionKey(partitions, rawKey)) continue;
    partitionKeys.push(rawKey);
    reverseAdj.set(rawKey, []);
  }
  if (!reverseAdj.has(partitionId)) {
    throw new Error(`Cannot query dependents on topology '${topologyId}': unknown partition '${partitionId}'.`);
  }
  for (const dependentKey of partitionKeys) {
    for (const upstreamKey of partitions[dependentKey].dependsOn ?? []) {
      reverseAdj.get(upstreamKey)?.push(dependentKey);
    }
  }
  return reverseAdj;
}
