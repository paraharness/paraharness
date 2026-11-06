import type { AgentContinuationFrame } from '../../ports/agent-continuation-frame.js';
import type { BranchableScope } from '../../ports/branchable-scope.js';
import type { ContinuationFrame } from '../../ports/continuation-frame.types.js';
import type { LedgerStore } from '../../ports/ledger-store.js';
import type { TopologyStore } from '../../ports/topology-store.js';
import type { StepContinuationQueue } from '../locks/step-continuation-queue.js';
import type { ServiceSessionRegistry } from '../services/service-session-registry.js';

/**
 * Parameters for `syncSuspendedRunPrerequisites()` during `'SUSPENDED'` wakeup or initial `QUEUED -> RUNNING` start.
 *
 * Supplies the prerequisite item keys, `LedgerStore`, optional `TopologyStore`, `BranchableScope`,
 * `ServiceSessionRegistry`, and active `AgentContinuationFrame`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface SyncPrerequisitesParams<THandle = unknown> {
  /** Enclosing flow run identifier. */
  readonly runId: string;
  /** Active step execution identifier. */
  readonly stepExecId: string;
  /** Prerequisite work item keys to synchronize against. */
  readonly prerequisiteItemKeys: readonly string[];
  /** Optional prerequisite run IDs for `TopologyStore.syncRunOverlays()`. */
  readonly prerequisiteRunIds?: readonly string[];
  /** Optional persisted `headScopeCheckpoint` restored before `syncRoot` on replay-idempotent wakeup. */
  readonly headScopeCheckpoint?: string;
  /** Active `AgentContinuationFrame` when resuming a suspended step, or `undefined` on initial run start. */
  readonly agentFrame?: AgentContinuationFrame;
  /** Outer continuation frames prefixing `agentFrame`. */
  readonly outerFrames?: readonly ContinuationFrame[];
  /** Durable `LedgerStore` queried for terminal receipts and updated with `syncedToPrerequisiteCheckpoint`. */
  readonly ledgerStore: LedgerStore;
  /** Optional `StepContinuationQueue` serializing continuation stack updates. */
  readonly continuationQueue?: StepContinuationQueue;
  /** Optional `TopologyStore` absorbing prerequisite run overlays. */
  readonly topologyStore?: TopologyStore;
  /** Optional `BranchableScope` executing `restoreCheckpoint` and `syncRoot`. */
  readonly branchableScope?: BranchableScope<THandle, Record<string, unknown>, Record<string, unknown>>;
  /** Optional `ServiceSessionRegistry` re-acquiring active skill services after `syncedToPrerequisiteCheckpoint`. */
  readonly serviceRegistry?: ServiceSessionRegistry;
  /** Active isolation scope handle. */
  readonly scopeHandle: THandle;
}
