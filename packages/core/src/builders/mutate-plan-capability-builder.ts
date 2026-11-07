import type { z } from 'zod';
import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type { AstBuilder } from '../ast/ast-builder.js';
import type { MutatePlanCapabilityNode } from '../ast/mutate-plan-capability-node.js';
import type { TopologyNode } from '../ast/topology-node.js';
import type { SpawnTasksBuilderOptions } from './spawn-tasks-builder-options.js';

/**
 * Fluent sub-builder for dynamic lane plan and topology contract mutation capabilities (`$cap.mutatePlan($m => ...)`).
 *
 * Enables `spawnTasks`, `addDependencies`, and `updatePartitionContract` orchestration tools
 * on the owning agent.
 *
 * @template TItem Work item payload type of the enclosing lane.
 */
export interface MutatePlanCapabilityBuilder<TItem = unknown>
  extends AstBuilder<MutatePlanCapabilityNode<TItem>> {
  /**
   * Enables the `spawnTasks` tool for enqueuing stacked prerequisite work items into the active lane.
   *
   * Validates that `options.maxSpawnedPerRun >= 1` and `options.maxPrerequisiteDepth >= 1`.
   *
   * @template TNewItem Spawned work item payload type validated by `itemSchema`.
   * @template TSig     Signal payload type for signal-correlated wakeup.
   *
   * @param {z.ZodType<TNewItem>}                      itemSchema - Zod schema validating spawned task items.
   * @param {SpawnTasksBuilderOptions<TNewItem, TSig>} options    - Spawn limits, patch, and wakeup options.
   *
   * @returns {MutatePlanCapabilityBuilder<TNewItem>} New immutable plan mutation builder.
   */
  canSpawnTasks<TNewItem, TSig = unknown>(
    itemSchema: z.ZodType<TNewItem>,
    options: SpawnTasksBuilderOptions<TNewItem, TSig>,
  ): MutatePlanCapabilityBuilder<TNewItem>;

  /**
   * Enables or disables the `addDependencies` tool for adding dependency edges between existing lane items.
   *
   * Cycle detection is enforced dynamically by the lane scheduler whenever `addDependencies` is called.
   *
   * @param {boolean} [enabled=true] - Whether the `addDependencies` tool is unlocked.
   *
   * @returns {MutatePlanCapabilityBuilder<TItem>} New immutable plan mutation builder.
   */
  canAddDependencies(enabled?: boolean): MutatePlanCapabilityBuilder<TItem>;

  /**
   * Enables the `updatePartitionContract` tool for updating the per-run CoW contract overlay of `topology`.
   *
   * Increments the mutated partition's contract epoch and invalidates downstream transitive dependents.
   *
   * @template TPart Literal partition identifier union of `topology`.
   *
   * @param {MaybeBuilder<TopologyNode<TPart>>} topology - Target relational topology node or builder.
   *
   * @returns {MutatePlanCapabilityBuilder<TItem>} New immutable plan mutation builder.
   */
  canUpdateTopologyContracts<TPart extends string = string>(
    topology: MaybeBuilder<TopologyNode<TPart>>,
  ): MutatePlanCapabilityBuilder<TItem>;
}
