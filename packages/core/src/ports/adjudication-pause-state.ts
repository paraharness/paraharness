import type { ContinuationFrame } from './continuation-frame.types.js';
import type { PendingToolBatch } from './pending-tool-batch.js';

/**
 * Pending interrupt adjudication metadata persisted inside `AdjudicationPauseState`.
 *
 * Captures the raised interrupt identifier, serialized payload, human request ID, and nested adjudicator stack.
 */
export interface PendingAdjudicationRecord {
  /** Identifier of the raised `InterruptNode`. */
  readonly interruptId: string;
  /** JSON-serialized interrupt payload passed to the adjudicator or human authority. */
  readonly interruptPayloadJson: string;
  /** Optional `requestId` persisted before invoking `HumanAdapter.requestDecision()`. */
  readonly humanRequestId?: string;
  /** Optional nested continuation stack for an in-flight `.adjudicateWith()` adjudicator session. */
  readonly adjudicatorStack?: readonly ContinuationFrame[];
}

/**
 * Pause state on `agent-frame` while awaiting `.adjudicateWith()` or `.ask()` interrupt resolution.
 *
 * Retains the suspended `PendingToolBatch` (if raised mid-tool-batch) alongside `PendingAdjudicationRecord`.
 */
export interface AdjudicationPauseState {
  /** Discriminant identifying an active interrupt adjudication pause. */
  readonly kind: 'adjudication';
  /** Optional suspended turn batch awaiting `.resumeWith()` replay. */
  readonly pendingToolBatch?: PendingToolBatch;
  /** Active interrupt adjudication metadata and nested adjudicator stack. */
  readonly pendingAdjudication: PendingAdjudicationRecord;
}
