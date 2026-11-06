import { createMutatePlanFromState } from './internal/mutate-plan-and-escalate-sub-builders.js';
import type { MutatePlanCapabilityBuilder } from './mutate-plan-capability-builder.js';

/**
 * Creates a fluent `MutatePlanCapabilityBuilder` for `cap.mutatePlan($m => ...)`.
 *
 * Initializes an immutable plan-mutation capability builder with `canAddDependencies: false`
 * and no initial task-spawning or topology-contract update permissions.
 *
 * @returns {MutatePlanCapabilityBuilder<unknown>} Frozen `MutatePlanCapabilityBuilder` instance.
 */
export function createMutatePlanCapabilityBuilder(): MutatePlanCapabilityBuilder<unknown> {
  return createMutatePlanFromState({
    spawnTasks: undefined,
    canAddDependencies: false,
    topologyToUpdate: undefined,
  });
}
