import type { ContinuationFrame } from './continuation-frame.types.js';
import type { PendingToolBatch } from './pending-tool-batch.js';

/**
 * Active-turn pause state on `agent-frame` when no tool batch or adjudication is suspended.
 *
 * Optionally tracks `inFlightPreToolCheckpoint` while a post-flight-diffed subprocess tool is executing.
 */
export type ActiveTurnPauseState = {
  /** Discriminant identifying an active LLM turn or idle post-turn boundary. */
  readonly kind: 'active-turn';
  /** Optional pre-tool checkpoint token persisted while a post-flight-diffed subprocess tool is executing. */
  readonly inFlightPreToolCheckpoint?: string;
};

/**
 * Tool-batch pause state on `agent-frame` while iterating or suspending across assistant tool calls `(1..k)`.
 *
 * Preserves the declaration-ordered `PendingToolBatch` queue and any in-flight subprocess checkpoint.
 */
export type ToolBatchPauseState = {
  /** Discriminant identifying an in-progress assistant tool batch. */
  readonly kind: 'tool-batch';
  /** Persisted turn-batch state containing `completedResults`, `blockedCalls`, and `remainingCalls`. */
  readonly pendingToolBatch: PendingToolBatch;
  /** Optional pre-tool checkpoint token persisted while a post-flight-diffed subprocess tool is executing. */
  readonly inFlightPreToolCheckpoint?: string;
};

/**
 * Pause state on `agent-frame` when an actor has emitted its structured output and is inside `beforeStop` gates.
 *
 * Indicates that tool calls are complete and deterministic `beforeStop` checks are being evaluated.
 */
export type BeforeStopGatePauseState = {
  /** Discriminant identifying the `beforeStop` verification gate phase. */
  readonly kind: 'before-stop-gate';
};

/**
 * Pending interrupt adjudication metadata persisted inside `AdjudicationPauseState`.
 *
 * Captures the raised interrupt identifier, serialized payload, human request ID, and nested adjudicator stack.
 */
export type PendingAdjudicationRecord = {
  /** Identifier of the raised `InterruptNode`. */
  readonly interruptId: string;
  /** JSON-serialized interrupt payload passed to the adjudicator or human authority. */
  readonly interruptPayloadJson: string;
  /** Optional `requestId` persisted before invoking `HumanAdapter.requestDecision()`. */
  readonly humanRequestId?: string;
  /** Optional nested continuation stack for an in-flight `.adjudicateWith()` adjudicator session. */
  readonly adjudicatorStack?: readonly ContinuationFrame[];
};

/**
 * Pause state on `agent-frame` while awaiting `.adjudicateWith()` or `.ask()` interrupt resolution.
 *
 * Retains the suspended `PendingToolBatch` (if raised mid-tool-batch) alongside `PendingAdjudicationRecord`.
 */
export type AdjudicationPauseState = {
  /** Discriminant identifying an active interrupt adjudication pause. */
  readonly kind: 'adjudication';
  /** Optional suspended turn batch awaiting `.resumeWith()` replay. */
  readonly pendingToolBatch?: PendingToolBatch;
  /** Active interrupt adjudication metadata and nested adjudicator stack. */
  readonly pendingAdjudication: PendingAdjudicationRecord;
};

/**
 * Pause state on `agent-frame` when suspended via `onPrerequisiteSpawned: 'suspend-and-yield-slot'`.
 *
 * Preserves the remaining assistant tool calls while the parent run yields its concurrency slot.
 */
export type PrerequisiteWaitPauseState = {
  /** Discriminant identifying a prerequisite task completion wait. */
  readonly kind: 'prerequisite-wait';
  /** Suspended turn batch containing the `spawnTasks` or `addDependencies` call and any trailing calls. */
  readonly pendingToolBatch: PendingToolBatch;
};

/**
 * Pause state on `agent-frame` during `.onLimitExceeded()` epistemic flush or `.replaceWith()` abort cleanup.
 *
 * Tracks whether `[LIMIT_EXCEEDED_FLUSH]` was injected, the flushed interrupt payload, and `abortMetaJson`.
 */
export type InterruptFlushPauseState = {
  /** Discriminant identifying a limit-exceeded flush or step-replacement abort sequence. */
  readonly kind: 'interrupt-flush';
  /** Identifier of the flush or replacement `InterruptNode`. */
  readonly interruptId: string;
  /** Whether the `[LIMIT_EXCEEDED_FLUSH]` prompt has already been injected into the transcript. */
  readonly flushPromptInjected?: boolean;
  /** Optional JSON-serialized interrupt payload produced by the `toolChoice: 'none'` flush turn. */
  readonly flushedInterruptPayloadJson?: string;
  /** Optional JSON-serialized metadata returned by the executed `AbortHookASTNode`. */
  readonly abortMetaJson?: string;
};

/**
 * Discriminated union consolidating mutually exclusive phase-specific pause payloads on `AgentContinuationFrame`.
 */
export type AgentPauseState =
  | ActiveTurnPauseState
  | ToolBatchPauseState
  | BeforeStopGatePauseState
  | AdjudicationPauseState
  | PrerequisiteWaitPauseState
  | InterruptFlushPauseState;
