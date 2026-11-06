import type { PendingToolBatch } from './pending-tool-batch.js';

/**
 * Pause state on `agent-frame` when suspended via `onPrerequisiteSpawned: 'suspend-and-yield-slot'`.
 *
 * Preserves the remaining assistant tool calls while the parent run yields its concurrency slot.
 */
export interface PrerequisiteWaitPauseState {
  /** Discriminant identifying a prerequisite task completion wait. */
  readonly kind: 'prerequisite-wait';
  /** Suspended turn batch containing the `spawnTasks` or `addDependencies` call and any trailing calls. */
  readonly pendingToolBatch: PendingToolBatch;
}
