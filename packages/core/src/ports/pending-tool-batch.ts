import type { ToolEffect } from './tool-effect.js';

/**
 * Violation record for a single tool call blocked pre-flight or post-flight by a policy guard clause.
 *
 * Passed inside `PolicyViolation.blockedCalls` to `.onViolation()` mappers and persisted on
 * `PendingToolBatch.blockedCalls` during interrupt adjudication.
 */
export interface PendingPreFlightCall {
  /** Wire-level tool call identifier from the assistant turn. */
  readonly callId: string;
  /** Name of the tool that triggered the guard violation. */
  readonly toolName: string;
  /** Raw JSON-serialized tool call argument object. */
  readonly argsJson: string;
  /** Specific `ToolEffect` descriptors that violated the guard clause and were not covered by active leases. */
  readonly violatedEffects: readonly ToolEffect[];
  /** Human- and LLM-readable summary of why the guard rejected the call. */
  readonly violationSummary: string;
}

/**
 * Entry in the declaration-ordered queue of unfinished tool calls (`remainingCalls`) for an assistant turn.
 *
 * Shifted atomically into `PendingToolBatch.completedResults` as each call finishes or replays
 * after `.resumeWith()`.
 */
export interface RemainingToolCallRecord {
  /** Wire-level tool call identifier (`1..k`). */
  readonly callId: string;
  /** Name of the invoked tool. */
  readonly toolName: string;
  /** Raw JSON-serialized tool call arguments. */
  readonly argsJson: string;
  /** Whether this call was blocked pre-flight by the currently adjudicating `'raise-interrupt'` clause. */
  readonly blockedPreFlight?: boolean;
  /** Identifiers of `'raise-interrupt'` guard clauses already adjudicated for this call. */
  readonly adjudicatedClauseIds?: readonly string[];
}

/**
 * Completed tool execution result entry accumulated within an assistant turn batch.
 *
 * Paired in declaration order when emitting the single `role: 'tool'` wire frame for the assistant turn.
 */
export interface CompletedToolBatchResultRecord {
  /** Wire-level tool call identifier paired by this result. */
  readonly callId: string;
  /** Serialized tool output text or error diagnostic message. */
  readonly content: string;
  /** Optional flag indicating whether the tool execution resulted in an error. */
  readonly isError?: boolean;
}

/**
 * Durable turn-batch state persisted on `agent-frame` across tool executions, fork/speculate sub-frames,
 * prerequisite suspensions, and interrupt adjudications.
 *
 * Guarantees that every `tool_use` block `(1..k)` in an assistant turn is executed or resolved
 * in strict declaration order before emitting the single pairing `role: 'tool'` wire frame.
 */
export interface PendingToolBatch {
  /** Already completed tool results `(1..m)` in the current assistant turn. */
  readonly completedResults: readonly CompletedToolBatchResultRecord[];
  /** Pre-flight or post-flight blocked tool calls awaiting adjudication. */
  readonly blockedCalls: readonly PendingPreFlightCall[];
  /** Optional `callId` of an active post-flight rollback or voluntary interrupt tool awaiting `.resumeWith()`. */
  readonly activeInterruptCallId?: string;
  /** Optional adjudication feedback persisted when `.resumeWith(feedback)` begins draining `remainingCalls`. */
  readonly adjudicationFeedback?: string;
  /** Declaration-ordered queue of unfinished tool calls `(i..k)` remaining in the assistant turn. */
  readonly remainingCalls: readonly RemainingToolCallRecord[];
}
