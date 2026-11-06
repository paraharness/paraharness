import type { ContinuationFrame } from './continuation-frame.types.js';
import type { LessonOutcome } from './lesson-outcome.types.js';

/**
 * Per-branch execution entry inside a `SpeculateContinuationFrame`.
 *
 * Tracks the branch index, child scope fork ID, tournament status, parked escalation payload,
 * and nested branch worker continuation stack.
 */
export interface SpeculateBranchEntryRecord {
  /** Zero-based index of the candidate branch (`0..branchCount - 1`). */
  readonly branchIndex: number;
  /** Unique child scope fork identifier for this candidate branch. */
  readonly forkId: string;
  /** Current tournament status of the candidate branch. */
  readonly status:
    | 'RUNNING'
    | 'COMPLETED'
    | 'FAILED'
    | 'PARKED_ON_ESCALATION'
    | 'WINNER_COMMITTED';
  /** Optional serialized scope checkpoint captured when the branch parks or completes. */
  readonly childScopeCheckpoint?: string;
  /** Optional JSON-serialized output payload when `status === 'COMPLETED'` or `'WINNER_COMMITTED'`. */
  readonly outputJson?: string;
  /** Optional JSON-serialized `TReceipt` from `scope.inspect(childHandle)` or `commitChild()`. */
  readonly scopeReceiptJson?: string;
  /** Optional error diagnostic summary when `status === 'FAILED'`. */
  readonly errorSummary?: string;
  /** Optional identifier of the interrupt on which the branch parked (`status === 'PARKED_ON_ESCALATION'`). */
  readonly parkedInterruptId?: string;
  /** Optional JSON-serialized escalation/interrupt payload when parked. */
  readonly parkedEscalationPayloadJson?: string;
  /** Nested outer-to-inner continuation stack for the branch worker executable. */
  readonly continuationStack: readonly ContinuationFrame[];
}

/**
 * Historical human ruling entry recorded when an arbiter unparks an escalated speculative branch.
 *
 * Appended to `SpeculateContinuationFrame.humanRulingsHistory` so subsequent arbiter rounds
 * see all prior human escalation decisions.
 */
export interface SpeculateHumanRulingRecord {
  /** Index of the speculative branch that was unparked for human decision. */
  readonly branchIndex: number;
  /** Identifier of the escalated interrupt resolved by the human authority. */
  readonly interruptId: string;
  /** Formatted summary of the human authority's ruling. */
  readonly rulingSummary: string;
}

/**
 * Buffered lesson outcome batch for a single speculative candidate branch.
 *
 * Flushed to `LessonStore.recordOutcomes()` only for `winnerBranchIndex` after `WINNER_COMMITTED`.
 */
export interface SpeculateBufferedLessonOutcomeRecord {
  /** Zero-based candidate branch index. */
  readonly branchIndex: number;
  /** Deduplicated `(lessonId, outcome)` pairs accumulated on this branch. */
  readonly outcomes: ReadonlyArray<{ readonly lessonId: string; readonly outcome: LessonOutcome }>;
}

/**
 * Serialized continuation frame for a `.speculate()` tournament (`kind: 'speculate-frame'`).
 *
 * Tracks parallel branch racing, deferred escalation parking (`PARKED_ON_ESCALATION`),
 * cross-verification, contested arbitration, winner cross-pollination refinement, and commit.
 */
export interface SpeculateContinuationFrame {
  /** Discriminant identifying a speculative tournament continuation frame. */
  readonly kind: 'speculate-frame';
  /** Step execution identifier of the parent actor that launched the tournament. */
  readonly parentStepExecId: string;
  /** Wire-level `callId` of the `.speculate()` tool invocation. */
  readonly callId: string;
  /** Name of the `.speculate()` capability tool. */
  readonly toolName: string;
  /** Current lifecycle phase of the speculative tournament. */
  readonly phase:
    | 'RACING'
    | 'CROSS_VERIFYING'
    | 'ARBITRATING'
    | 'REFINING_WINNER'
    | 'COMMITTING';
  /** Selected winning branch index once arbitration or sole-survivor resolution succeeds. */
  readonly winnerBranchIndex?: number;
  /** Serialized checkpoint of the winning handle captured prior to `.refineWinnerWhen()` execution. */
  readonly preRefinementCheckpoint?: string;
  /** Number of 3-way `commitChild` conflict-bounce retries attempted for the winning branch. */
  readonly conflictRetryCount: number;
  /** Whether `conflictCleanCheck` is armed on the winning branch handle. */
  readonly conflictCheckArmed: boolean;
  /** Whether buffered lesson outcomes for the winning branch have been flushed to `LessonStore`. */
  readonly lessonsFlushed?: boolean;
  /** Optional continuation stack for an in-flight arbiter or `.refineWinnerWhen()` session. */
  readonly activeSubStack?: readonly ContinuationFrame[];
  /** State records for all `0..branchCount - 1` candidate branches. */
  readonly branches: readonly SpeculateBranchEntryRecord[];
  /** Chronological history of human rulings gathered across `'unpark-escalation'` rounds. */
  readonly humanRulingsHistory: readonly SpeculateHumanRulingRecord[];
  /** Per-branch buffered lesson outcomes flushed only for the committed winner. */
  readonly bufferedLessonOutcomes?: readonly SpeculateBufferedLessonOutcomeRecord[];
}
