import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import { extractAST } from '../ast/extract-ast.js';
import type { TopologyNode } from '../ast/topology-node.js';
import { computeTransitiveDependents } from './internal/validate-topology-dag.js';

/**
 * Returns all strict transitive dependent partitions that depend (directly or indirectly) on `partitionId`.
 *
 * Given `db <- api <- web`, `dependentsOf(topology, 'db')` returns `['api', 'web']` and
 * `dependentsOf(topology, 'web')` returns `[]`.
 *
 * @template TPartition Literal string union of partition identifiers in `topology`.
 *
 * @param {MaybeBuilder<TopologyNode<TPartition>>} topology    - Compiled `TopologyNode` or `H.topology(...)` builder.
 * @param {TPartition}                             partitionId - Source partition identifier to query.
 *
 * @returns {readonly TPartition[]} Frozen array of strict transitive dependent partition IDs.
 *
 * @throws {Error} If `partitionId` is not a declared partition in `topology`.
 */
export function dependentsOf<TPartition extends string = string>(
  topology: MaybeBuilder<TopologyNode<TPartition>>,
  partitionId: TPartition,
): readonly TPartition[] {
  const node = extractAST(topology);
  return computeTransitiveDependents(node.id, node.partitions, partitionId);
}

/**
 * Returns `[partitionId, ...dependentsOf(topology, partitionId)]`, representing all partitions impacted by a change in `partitionId`.
 *
 * Given `db <- api <- web`, `affectedBy(topology, 'db')` returns `['db', 'api', 'web']`.
 *
 * @template TPartition Literal string union of partition identifiers in `topology`.
 *
 * @param {MaybeBuilder<TopologyNode<TPartition>>} topology    - Compiled `TopologyNode` or `H.topology(...)` builder.
 * @param {TPartition}                             partitionId - Source partition identifier to query.
 *
 * @returns {readonly TPartition[]} Frozen array starting with `partitionId` followed by its strict transitive dependents.
 *
 * @throws {Error} If `partitionId` is not a declared partition in `topology`.
 */
export function affectedBy<TPartition extends string = string>(
  topology: MaybeBuilder<TopologyNode<TPartition>>,
  partitionId: TPartition,
): readonly TPartition[] {
  const strictDependents = dependentsOf(topology, partitionId);
  return Object.freeze([partitionId, ...strictDependents]);
}
