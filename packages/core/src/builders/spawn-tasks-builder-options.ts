import type { BivariantCallback, MaybeBuilder } from '../ast/ast-foundation.types.js';
import type { SignalNode } from '../ast/signal-node.js';

/**
 * Options passed to `MutatePlanCapabilityBuilder.canSpawnTasks(itemSchema, options)`.
 *
 * Configures per-run spawn limits, transitive prerequisite depth bounds, mandatory patch
 * fields, slot-yield behavior, priority inheritance, and wakeup correlation rules.
 *
 * @template TItem Work item payload type of the enclosing lane.
 * @template TSig  Signal payload type for signal-correlated wakeup.
 */
export interface SpawnTasksBuilderOptions<TItem = unknown, TSig = unknown> {
  /** Maximum number of prerequisite tasks a single run may spawn. */
  readonly maxSpawnedPerRun: number;
  /** Maximum transitive prerequisite depth allowed in the lane DAG (default `3`). */
  readonly maxPrerequisiteDepth?: number;
  /** Optional partial item fields forcibly applied to every spawned task. */
  readonly enforcePatch?: Partial<TItem>;
  /** Slot-livelock prevention policy (`'suspend-and-yield-slot'`). */
  readonly onPrerequisiteSpawned?: 'suspend-and-yield-slot';
  /** Priority inheritance strategy (`'inherit-parent-with-boost'` default or `'normal'`). */
  readonly priorityStrategy?: 'inherit-parent-with-boost' | 'normal';
  /** Wakeup condition determining when the suspended parent run becomes eligible to resume. */
  readonly resumeWhen?:
    | 'prerequisite-exit'
    | {
        readonly signal: MaybeBuilder<SignalNode<TSig>>;
        readonly correlateBy: BivariantCallback<[sig: TSig], string>;
      };
}
