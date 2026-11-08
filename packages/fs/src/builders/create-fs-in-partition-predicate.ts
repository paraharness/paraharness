import type { FsPartitionMapNode, ScopePredicate } from '@metaharness/core';
import { createFsGlobMatcherBuilder } from './create-fs-glob-matcher-builder.js';

/**
 * Builds a `ScopePredicate` matching a specific partition in `partitionMap` (`fs.inPartition`).
 *
 * Populates both `partitions: [partitionId]` for Turn-0 partition injection and `effects`
 * with an `'any'`-mode `FsGlobMatcherNode` covering the partition's member globs.
 *
 * @template TPartition Literal union of partition identifiers in `partitionMap`.
 *
 * @param {FsPartitionMapNode<TPartition>} partitionMap - Filesystem partition map AST node.
 * @param {TPartition}                     partitionId  - Target partition identifier to scope against.
 *
 * @returns {ScopePredicate} Frozen `ScopePredicate` record for scoped rules and skills.
 */
export function createFsInPartitionPredicate<TPartition extends string = string>(
  partitionMap: FsPartitionMapNode<TPartition>,
  partitionId: TPartition,
): ScopePredicate {
  const entry = partitionMap.mapping[partitionId];
  if (entry === undefined) {
    throw new Error(
      `fs.inPartition failed: partition '${partitionId}' is not defined in topology '${partitionMap.topology.id}'.`,
    );
  }
  return Object.freeze<ScopePredicate>({
    partitions: [partitionId],
    effects: createFsGlobMatcherBuilder(entry.globs, 'any'),
  });
}
