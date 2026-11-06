import type { BivariantCallback } from './ast-foundation.types.js';
import type { BaseTopologyStoreASTNode } from './base/base-topology-store-ast-node.js';
import type { SignalNode } from './signal-node.js';

/**
 * Dependency constraint declaration for a single partition in a relational `TopologyNode`.
 *
 * Lists the upstream partitions whose public contracts this partition directly depends upon
 * in the relational topology DAG.
 *
 * @template TPartition Union of valid partition identifiers in the topology.
 */
export interface TopologyPartitionConstraint<TPartition extends string = string> {
  /** Upstream partition identifiers that this partition depends on. */
  readonly dependsOn?: readonly TPartition[];
}

/**
 * Signal-to-run correlation rule for committing or discarding a sealed topology overlay.
 *
 * Extracts the lane `itemKey` (and optional `baseBranch`) from an incoming `SignalNode` payload
 * to match against `SEALED_UNMERGED` run overlays in the topology store.
 *
 * @template TSig Validated signal payload type.
 */
export interface TopologySignalCorrelation<TSig = unknown> {
  /** Signal that triggers the topology overlay transition. */
  readonly signal: SignalNode<TSig>;
  /** Pure projection extracting the lane `itemKey` from the signal payload. */
  readonly correlateBy: BivariantCallback<[sig: TSig], string>;
  /** Optional projection extracting the target merge base branch from the signal payload. */
  readonly baseBranch?: BivariantCallback<[sig: TSig], string>;
}

/**
 * Lifecycle policy governing when a run's Copy-on-Write topology overlay commits to the base store.
 *
 * Supports PR-merged signal correlation (`onSignal`), unmerged PR closure cleanup (`discardOnSignal`),
 * and maximum sealed age expiration (`maxSealedAgeHours`).
 *
 * @template TOnSig      Payload type of the commit signal.
 * @template TDiscardSig Payload type of the discard signal.
 */
export interface TopologyCommitOverlayConfig<TOnSig = unknown, TDiscardSig = unknown> {
  /** Signal correlation rule that commits a `SEALED_UNMERGED` overlay when a change ships. */
  readonly onSignal?: TopologySignalCorrelation<TOnSig>;
  /** Signal correlation rule that discards a `SEALED_UNMERGED` overlay when a PR closes unmerged. */
  readonly discardOnSignal?: TopologySignalCorrelation<TDiscardSig>;
  /** Maximum age in hours a sealed overlay is retained before automatic discard (defaults to `168`). */
  readonly maxSealedAgeHours?: number;
}

/**
 * Passive AST node defining the directed acyclic graph (DAG) of logical system partitions.
 *
 * Tracks partition dependencies (`dependsOn`) and Copy-on-Write overlay commit triggers without
 * coupling core orchestration to physical files or globs.
 *
 * @template TPartition Union of partition identifier string literals.
 */
export interface TopologyNode<TPartition extends string = string> {
  /** Discriminant identifying a relational topology AST node. */
  readonly type: 'harness:topology';
  /** Unique logical identifier of the topology graph. */
  readonly id: string;
  /** Backing topology store AST descriptor. */
  readonly store: BaseTopologyStoreASTNode;
  /** Directed dependency map across all declared partitions. */
  readonly partitions: Readonly<Record<TPartition, TopologyPartitionConstraint<TPartition>>>;
  /** Optional signal-correlated overlay commit and discard configuration. */
  readonly commitOverlayWhen?: TopologyCommitOverlayConfig;
}
