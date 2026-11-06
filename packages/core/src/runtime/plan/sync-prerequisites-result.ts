import type { AgentContinuationFrame } from '../../ports/agent-continuation-frame.js';
import type { LeaseDelta } from '../../ports/lease-delta.js';

/**
 * Outcome returned by `syncSuspendedRunPrerequisites()` after synchronizing prerequisite receipts and overlays.
 *
 * Carries formatted synchronization notes (`[PREREQUISITE_SYNC]`, `[PREREQUISITE_FAILED]`, `[SERVICE_REACQUIRED]`),
 * any conflict resolution lease, and the updated `AgentContinuationFrame`.
 */
export interface SyncPrerequisitesResult {
  /** True when all prerequisites completed cleanly in an allowed exit state. */
  readonly allPrerequisitesSucceeded: boolean;
  /** Synchronization note strings to append to the transcript before draining `remainingCalls`. */
  readonly syncNotes: readonly string[];
  /** Optional conflict resolution lease granted when `syncRoot` returned `status: 'conflict'`. */
  readonly conflictLease?: LeaseDelta;
  /** Whether `conflictCleanCheck` was armed by a conflicted `syncRoot`. */
  readonly conflictCheckArmed: boolean;
  /** Updated `AgentContinuationFrame` with `syncedToPrerequisiteCheckpoint` persisted. */
  readonly updatedAgentFrame?: AgentContinuationFrame;
}
