import type { InterruptedStepBootRecord } from '../../ports/interrupted-step-boot-record.js';
import type { FlowExecutionContext } from '../flow/flow-execution-context.js';

/**
 * In-memory scheduling record for a work item tracked by `LaneScheduler` (`SPEC.md` §3.10).
 *
 * Tracks the item's lifecycle status, prerequisite `dependsOn` keys, cumulative USD cost,
 * approved budget ceiling, and active `FlowExecutionContext` when running.
 *
 * @template TIn Validated lane work item input type.
 */
export interface LaneQueuedItemState<TIn = unknown> {
  /** Unique run identifier (`runId`). */
  readonly runId: string;
  /** Deduplication key (`itemKey`) returned by `lane.keyMapper(input)`. */
  readonly itemKey: string;
  /** Enclosing `LaneNode.id`. */
  readonly laneId: string;
  /** Latest validated work item input payload. */
  input: TIn;
  /** Current lifecycle status of the item inside the lane. */
  status: 'QUEUED' | 'WAITING' | 'RUNNING' | 'SUSPENDED' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'ABANDONED';
  /** Terminal exit state label (`flow.exitState`, `waitFor.onAbandonedState`, `retry.orFailState`, or `'cancelled'`). */
  terminalExitState?: string;
  /** Epoch milliseconds when the item was enqueued. */
  readonly enqueuedAtMs: number;
  /** Additional priority weight boost (`'inherit-parent-with-boost'`). */
  priorityBoost: number;
  /** Prerequisite item keys (`itemKey`s) that must exit `'done'` before this item starts or resumes. */
  dependsOn: readonly string[];
  /** Cumulative USD cost accrued by the run. */
  costUsd: number;
  /** Effective USD budget ceiling (initially `lane.maxCostUsd?.limitUsd`, updated on human approval). */
  approvedMaxCostUsd?: number;
  /** Final scope receipt (`TReceipt`) captured when the run completed or sealed. */
  scopeReceipt?: Record<string, unknown>;
  /** Active `FlowExecutionContext` while the run is executing. */
  activeFlowCtx?: FlowExecutionContext<TIn, unknown>;
  /** Optional interrupted step boot record pending recovery on next schedule pass. */
  bootRecord?: InterruptedStepBootRecord;
}
