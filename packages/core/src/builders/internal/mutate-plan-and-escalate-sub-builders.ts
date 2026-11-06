import type { z } from 'zod';
import type { MaybeBuilder } from '../../ast/ast-foundation.types.js';
import { extractAST } from '../../ast/extract-ast.js';
import type { MutatePlanCapabilityNode } from '../../ast/mutate-plan-capability-node.js';
import type { SignalNode } from '../../ast/signal-node.js';
import type { TopologyNode } from '../../ast/topology-node.js';
import type { MutatePlanCapabilityBuilder } from '../mutate-plan-capability-builder.js';
import type { SpawnTasksBuilderOptions } from '../spawn-tasks-builder-options.js';
import { deepFreeze } from './deep-freeze.js';
import type { MutatePlanCapabilityBuilderState } from './mutate-plan-capability-builder-state.js';

/**
 * Validates that a numeric option is a strictly positive integer (`>= 1`).
 *
 * Throws an actionable error naming the builder construct and option when a non-integer
 * or non-positive number is supplied.
 *
 * @param {string} constructLabel - Construct and option label for error reporting.
 * @param {number} value          - Numeric value to validate.
 *
 * @throws {Error} If `value` is not a positive integer `>= 1`.
 */
export function assertPositiveInteger(constructLabel: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${constructLabel} requires a positive integer >= 1 (received ${value}).`);
  }
}

/**
 * Creates a copy-on-write immutable `MutatePlanCapabilityBuilder` from an internal state snapshot.
 *
 * Normalizes default `maxPrerequisiteDepth: 3`, `onPrerequisiteSpawned: 'suspend-and-yield-slot'`,
 * `priorityStrategy: 'inherit-parent-with-boost'`, and `resumeWhen: 'prerequisite-exit'` options.
 *
 * @template TItem Work item payload type of the enclosing lane.
 *
 * @param {MutatePlanCapabilityBuilderState<TItem>} state - Current mutatePlan builder state.
 *
 * @returns {MutatePlanCapabilityBuilder<TItem>} Frozen mutatePlan capability builder.
 */
export function createMutatePlanFromState<TItem = unknown>(
  state: MutatePlanCapabilityBuilderState<TItem>,
): MutatePlanCapabilityBuilder<TItem> {
  return Object.freeze<MutatePlanCapabilityBuilder<TItem>>({
    canSpawnTasks<TNewItem, TSig = unknown>(
      itemSchema: z.ZodType<TNewItem, z.ZodTypeDef, unknown>,
      options: SpawnTasksBuilderOptions<TNewItem, TSig>,
    ): MutatePlanCapabilityBuilder<TNewItem> {
      const maxPrerequisiteDepth = options.maxPrerequisiteDepth ?? 3;
      assertPositiveInteger('$cap.mutatePlan.canSpawnTasks(maxSpawnedPerRun)', options.maxSpawnedPerRun);
      assertPositiveInteger('$cap.mutatePlan.canSpawnTasks(maxPrerequisiteDepth)', maxPrerequisiteDepth);
      const resumeWhen =
        options.resumeWhen === undefined || options.resumeWhen === 'prerequisite-exit'
          ? ('prerequisite-exit' as const)
          : { signal: extractAST<SignalNode<TSig>>(options.resumeWhen.signal), correlateBy: options.resumeWhen.correlateBy };
      return createMutatePlanFromState<TNewItem>({
        spawnTasks: {
          itemSchema,
          maxSpawnedPerRun: options.maxSpawnedPerRun,
          maxPrerequisiteDepth,
          enforcePatch: options.enforcePatch,
          onPrerequisiteSpawned: options.onPrerequisiteSpawned ?? 'suspend-and-yield-slot',
          priorityStrategy: options.priorityStrategy ?? 'inherit-parent-with-boost',
          resumeWhen,
        },
        canAddDependencies: state.canAddDependencies,
        topologyToUpdate: state.topologyToUpdate,
      });
    },
    canAddDependencies: (enabled = true) => createMutatePlanFromState<TItem>({ ...state, canAddDependencies: enabled }),
    canUpdateTopologyContracts: <TPart extends string = string>(topology: MaybeBuilder<TopologyNode<TPart>>) =>
      createMutatePlanFromState<TItem>({ ...state, topologyToUpdate: extractAST(topology) }),
    toAST: (): MutatePlanCapabilityNode<TItem> =>
      deepFreeze<MutatePlanCapabilityNode<TItem>>({ ...state, type: 'harness:mutate-plan-capability' }),
  });
}
