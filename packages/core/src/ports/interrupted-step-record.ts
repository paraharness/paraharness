import type { ContinuationFrame } from './continuation-frame.types.js';

/**
 * Non-terminal run and step record returned by `LedgerStore.getInterruptedStepsOnBoot()`.
 *
 * Provides the persisted run status, dependencies, scope checkpoints, and continuation stack
 * needed to recover interrupted or suspended runs on startup.
 */
export interface InterruptedStepRecord {
  /** Unique identifier of the non-terminal flow run. */
  readonly runId: string;
  /** Identifier of the enclosing `LaneNode`. */
  readonly laneId: string;
  /** Work item key of the run. */
  readonly itemKey: string;
  /** Latest JSON-serialized flow input payload. */
  readonly inputJson: string;
  /** Non-terminal run lifecycle status. */
  readonly status: 'QUEUED' | 'RUNNING' | 'WAITING' | 'SUSPENDED';
  /** Prerequisite item keys that this run depends on. */
  readonly dependsOn: readonly string[];
  /** Active step execution identifier, or `null` if the crash occurred between steps. */
  readonly stepExecId: string | null;
  /** Active flow step identifier, or `null` if the crash occurred between steps. */
  readonly stepId: string | null;
  /** Optional active executable identifier (such as a `.replaceWith()` replacement actor). */
  readonly executableId?: string;
  /** Optional serialized scope checkpoint captured at step start. */
  readonly baseScopeCheckpoint?: string;
  /** Optional serialized scope checkpoint captured when the step entered `'SUSPENDED'`. */
  readonly headScopeCheckpoint?: string;
  /** Persisted outer-to-inner continuation stack for the active step. */
  readonly continuationStack: readonly ContinuationFrame[];
}
