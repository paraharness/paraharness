import type { z } from 'zod';
import type { BivariantCallback } from './ast-foundation.types.js';
import type { SignalNode } from './signal-node.js';
import type { TopologyNode } from './topology-node.js';

/**
 * Signal-correlated wakeup condition for a parent run suspended after spawning prerequisite tasks.
 *
 * Keeps the parent run suspended until `signal` arrives for every spawned prerequisite item key
 * matched via `correlateBy(sig)`.
 *
 * @template TSig Signal payload type.
 */
export interface SpawnTasksSignalResumeCondition<TSig = unknown> {
  /** External signal triggering parent run wakeup. */
  readonly signal: SignalNode<TSig>;
  /** Pure synchronous correlation extractor mapping `TSig` to the prerequisite item key or ref. */
  readonly correlateBy: BivariantCallback<[sig: TSig], string>;
}

/**
 * Configuration for the `spawnTasks` plan-mutation capability tool (`canSpawnTasks`).
 *
 * Enforces per-run spawn count and DAG depth ceilings, mandatory slot suspension on prerequisite
 * creation, priority inheritance, and wakeup conditions.
 *
 * @template TItem Work item payload type of the enclosing lane.
 */
export interface SpawnTasksConfig<TItem = unknown> {
  /** Zod schema validating each spawned work item. */
  readonly itemSchema: z.ZodType<TItem, z.ZodTypeDef, unknown>;
  /** Maximum number of prerequisite tasks a single run may spawn. */
  readonly maxSpawnedPerRun: number;
  /** Maximum transitive prerequisite depth allowed in the lane DAG (default `3`). */
  readonly maxPrerequisiteDepth: number;
  /** Optional partial item fields forcibly applied to every spawned task (e.g. `{ routingTier: 'deep' }`). */
  readonly enforcePatch?: Partial<TItem>;
  /** Slot-livelock prevention policy requiring the parent run to suspend and yield its concurrency slot. */
  readonly onPrerequisiteSpawned: 'suspend-and-yield-slot';
  /** Priority inheritance strategy for spawned prerequisite tasks (`'inherit-parent-with-boost'` default or `'normal'`). */
  readonly priorityStrategy: 'inherit-parent-with-boost' | 'normal';
  /** Wakeup condition determining when the suspended parent run becomes eligible to resume. */
  readonly resumeWhen: 'prerequisite-exit' | SpawnTasksSignalResumeCondition;
}

/**
 * Passive AST node representing dynamic lane plan and topology contract mutation capabilities (`$cap.mutatePlan($m => ...)`).
 *
 * Exposes `spawnTasks`, `addDependencies`, and `updatePartitionContract` capability tools on the
 * parent agent according to the configured flags and `topologyToUpdate`.
 *
 * @template TItem Work item payload type of the enclosing lane.
 */
export interface MutatePlanCapabilityNode<TItem = unknown> {
  /** Discriminant identifying a plan mutation capability AST node. */
  readonly type: 'harness:mutate-plan-capability';
  /** Optional `spawnTasks` tool configuration for enqueuing stacked prerequisite work items. */
  readonly spawnTasks?: SpawnTasksConfig<TItem>;
  /** True when the agent is permitted to add dependency edges between existing lane items (`addDependencies`). */
  readonly canAddDependencies: boolean;
  /** Optional relational topology whose per-run CoW contract overlay the agent may update (`updatePartitionContract`). */
  readonly topologyToUpdate?: TopologyNode;
}
