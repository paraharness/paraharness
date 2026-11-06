import type { ContinuationFrame } from '../../ports/continuation-frame.types.js';
import type { LessonOutcome } from '../../ports/lesson-outcome.types.js';

/**
 * Outcome returned by a child step execution inside a downward `.fork()` or `resumeFork` batch.
 *
 * Distinguishes normal completion (`status: 'completed'`) from an upward interrupt raised to the parent (`status: 'interrupt-raised'`).
 *
 * @template TOut Validated output payload type of the child executable.
 */
export interface ChildForkExecutionOutcome<TOut = unknown> {
  /** Discriminant indicating whether the child completed or raised an upward interrupt. */
  readonly status: 'completed' | 'interrupt-raised';
  /** Validated output payload when `status === 'completed'`. */
  readonly output?: TOut;
  /** Final leaf message ID of the child transcript. */
  readonly leafMessageId?: string | null;
  /** Deduplicated lesson outcomes accumulated during child execution. */
  readonly accumulatedLessonOutcomes?: Readonly<Record<string, LessonOutcome>>;
  /** Raised interrupt identifier when `status === 'interrupt-raised'`. */
  readonly interruptId?: string;
  /** Validated interrupt payload when `status === 'interrupt-raised'`. */
  readonly interruptPayload?: unknown;
  /** Phase that raised the interrupt (`'act'` vs `'evaluate'`). */
  readonly raisedByPhase?: 'act' | 'evaluate';
  /** Tool call ID that raised the interrupt when raised from an `.act()` tool call. */
  readonly suspendedAtCallId?: string;
  /** Serialized child continuation stack at the moment of suspension or completion. */
  readonly continuationStack: readonly ContinuationFrame[];
}
