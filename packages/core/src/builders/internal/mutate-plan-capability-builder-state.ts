import type { SpawnTasksConfig } from '../../ast/mutate-plan-capability-node.js';
import type { TopologyNode } from '../../ast/topology-node.js';

/**
 * Immutable copy-on-write state snapshot backing `MutatePlanCapabilityBuilder`.
 *
 * Records whether `spawnTasks`, `addDependencies`, and `updatePartitionContract`
 * tools are unlocked on the parent agent.
 *
 * @template TItem Work item payload type of the enclosing lane.
 */
export interface MutatePlanCapabilityBuilderState<TItem = unknown> {
  /** Optional prerequisite task spawning configuration. */
  readonly spawnTasks: SpawnTasksConfig<TItem> | undefined;
  /** Whether the `addDependencies` tool is unlocked. */
  readonly canAddDependencies: boolean;
  /** Optional relational topology whose per-run CoW contract overlay may be updated. */
  readonly topologyToUpdate: TopologyNode | undefined;
}
