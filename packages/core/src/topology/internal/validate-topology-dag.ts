import { Graph, alg } from '@dagrejs/graphlib';
import type { TopologyPartitionConstraint } from '../../ast/topology-node.js';

/**
 * Narrowing predicate verifying that a candidate string key is an own property of `partitions`.
 *
 * Prevents prototype properties from being treated as declared topology partitions when iterating `Object.keys`.
 *
 * @template TPartition Literal string union of partition identifiers.
 *
 * @param {Readonly<Record<TPartition, TopologyPartitionConstraint<TPartition>>>} partitions - Partition dependency map.
 * @param {string}                                                                key        - Candidate key string to check.
 *
 * @returns {key is TPartition} True when `key` is an own property of `partitions`.
 */
function isPartitionKey<TPartition extends string>(
  partitions: Readonly<Record<TPartition, TopologyPartitionConstraint<TPartition>>>,
  key: string,
): key is TPartition {
  return Object.prototype.hasOwnProperty.call(partitions, key);
}

/**
 * Traces a deterministic directed cycle path (`a -> b -> a`) inside a strongly connected component reported by `alg.findCycles`.
 *
 * Starts at `startKey` and walks `graph.successors` restricted to `componentSet` until a visited partition repeats.
 *
 * @param {Graph}               graph        - Directed partition dependency graph.
 * @param {ReadonlySet<string>} componentSet - Strongly connected cycle component membership set.
 * @param {string}              startKey     - Initial partition key in the component.
 *
 * @returns {string} Formatted cycle path string (`p1 -> p2 -> ... -> p1`).
 */
function formatCyclePath(graph: Graph, componentSet: ReadonlySet<string>, startKey: string): string {
  const trail: string[] = [];
  const seen = new Set<string>();
  let current = startKey;
  while (!seen.has(current)) {
    seen.add(current);
    trail.push(current);
    const successors = graph.successors(current) ?? [];
    const nextInCycle = successors.find((candidate: string) => componentSet.has(candidate));
    if (nextInCycle === undefined) break;
    current = nextInCycle;
  }
  const cycleStartIdx = trail.indexOf(current);
  const orderedCycle = cycleStartIdx >= 0 ? [...trail.slice(cycleStartIdx), current] : [...trail, startKey];
  return orderedCycle.join(' -> ');
}

/**
 * Extracts and validates all own partition keys declared on `partitions`.
 *
 * Ensures at least one partition is declared and every partition key is a non-empty identifier.
 *
 * @template TPartition Literal string union of partition identifiers.
 *
 * @param {string}                                                                topologyId - Unique identifier of the topology.
 * @param {Readonly<Record<TPartition, TopologyPartitionConstraint<TPartition>>>} partitions - Partition dependency map.
 *
 * @returns {readonly TPartition[]} Ordered list of own partition keys.
 *
 * @throws {Error} If `partitions` is empty or contains an empty/whitespace partition identifier.
 */
function collectDeclaredPartitions<TPartition extends string>(
  topologyId: string,
  partitions: Readonly<Record<TPartition, TopologyPartitionConstraint<TPartition>>>,
): readonly TPartition[] {
  const declaredKeys = Object.keys(partitions).filter((key): key is TPartition =>
    isPartitionKey(partitions, key),
  );
  if (declaredKeys.length === 0) {
    throw new Error(`Topology '${topologyId}' must declare at least one partition.`);
  }
  for (const key of declaredKeys) {
    if (key.trim().length === 0) {
      throw new Error(`Topology '${topologyId}' contains an empty partition identifier.`);
    }
  }
  return declaredKeys;
}

/**
 * Constructs a forward dependency graph (`dependent -> upstream`) and validates all direct edges.
 *
 * Rejects unknown upstream partition references and direct self-dependency edges (`key -> key`).
 *
 * @template TPartition Literal string union of partition identifiers.
 *
 * @param {string}                                                                topologyId   - Unique identifier of the topology.
 * @param {Readonly<Record<TPartition, TopologyPartitionConstraint<TPartition>>>} partitions   - Partition dependency map.
 * @param {readonly TPartition[]}                                                 declaredKeys - Validated partition keys.
 *
 * @returns {Graph} Directed forward dependency graph.
 *
 * @throws {Error} If any partition depends on an unknown partition or directly on itself.
 */
function buildForwardDependencyGraph<TPartition extends string>(
  topologyId: string,
  partitions: Readonly<Record<TPartition, TopologyPartitionConstraint<TPartition>>>,
  declaredKeys: readonly TPartition[],
): Graph {
  const graph = new Graph({ directed: true });
  for (const key of declaredKeys) {
    graph.setNode(key);
  }
  for (const key of declaredKeys) {
    for (const dep of partitions[key].dependsOn ?? []) {
      if (!graph.hasNode(dep)) {
        throw new Error(
          `Topology '${topologyId}' partition '${key}' depends on unknown partition '${dep}'.`,
        );
      }
      if (dep === key) {
        throw new Error(
          `Topology '${topologyId}' contains a self-dependency cycle on partition '${key}' (${key} -> ${key}).`,
        );
      }
      graph.setEdge(key, dep);
    }
  }
  return graph;
}

/**
 * Constructs a reverse dependency graph (`upstream -> dependent`) for transitive dependent queries.
 *
 * @template TPartition Literal string union of partition identifiers.
 *
 * @param {Readonly<Record<TPartition, TopologyPartitionConstraint<TPartition>>>} partitions   - Partition dependency map.
 * @param {readonly TPartition[]}                                                 declaredKeys - Validated partition keys.
 *
 * @returns {Graph} Directed reverse dependency graph.
 */
function buildReverseDependencyGraph<TPartition extends string>(
  partitions: Readonly<Record<TPartition, TopologyPartitionConstraint<TPartition>>>,
  declaredKeys: readonly TPartition[],
): Graph {
  const reverseGraph = new Graph({ directed: true });
  for (const key of declaredKeys) {
    reverseGraph.setNode(key);
  }
  for (const dependentKey of declaredKeys) {
    for (const upstreamKey of partitions[dependentKey].dependsOn ?? []) {
      reverseGraph.setEdge(upstreamKey, dependentKey);
    }
  }
  return reverseGraph;
}

/**
 * Validates that a topology's partition map has non-empty partition IDs, valid `dependsOn` references, and zero directed cycles.
 *
 * Builds a directed `Graph` using `@dagrejs/graphlib` and invokes `alg.findCycles` to reject self-loops and multi-node cycles at AST build time.
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
  const declaredKeys = collectDeclaredPartitions(topologyId, partitions);
  const graph = buildForwardDependencyGraph(topologyId, partitions, declaredKeys);
  const firstCycle = alg.findCycles(graph)[0];
  if (firstCycle !== undefined) {
    const componentSet = new Set<string>(firstCycle);
    const startKey = declaredKeys.find((key) => componentSet.has(key)) ?? firstCycle[0] ?? '';
    throw new Error(
      `Topology '${topologyId}' contains a dependency cycle: ${formatCyclePath(graph, componentSet, startKey)}.`,
    );
  }
}

/**
 * Computes all strict transitive dependent partitions of `partitionId` using `@dagrejs/graphlib` traversal.
 *
 * Constructs the reverse dependency graph in `@dagrejs/graphlib` and runs `alg.preorder` from `partitionId`
 * without including `partitionId` itself in the returned list.
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
  const declaredKeys = Object.keys(partitions).filter((key): key is TPartition =>
    isPartitionKey(partitions, key),
  );
  const reverseGraph = buildReverseDependencyGraph(partitions, declaredKeys);
  if (!reverseGraph.hasNode(partitionId)) {
    throw new Error(
      `Cannot query dependents on topology '${topologyId}': unknown partition '${partitionId}'.`,
    );
  }
  const reachable = alg.preorder(reverseGraph, [partitionId]);
  const strictDependents = reachable.filter(
    (nodeKey): nodeKey is TPartition =>
      nodeKey !== partitionId && isPartitionKey(partitions, nodeKey),
  );
  return Object.freeze(strictDependents);
}
