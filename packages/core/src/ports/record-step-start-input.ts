import type { ContinuationFrame } from './continuation-frame.types.js';

export type { StepStartRecord } from './step-start-record.js';

/**
 * Input record passed to `LedgerStore.recordStepStart()`.
 *
 * Captures the step execution ID, enclosing run and step IDs, optional promoted executable ID,
 * base scope checkpoint, and initial outer-to-inner continuation stack.
 */
export interface RecordStepStartInput {
  /** Unique execution identifier for this step attempt. */
  readonly stepExecId: string;
  /** Identifier of the enclosing flow run. */
  readonly runId: string;
  /** Logical identifier of the `FlowStepNode` or `FlowBranchNode`. */
  readonly stepId: string;
  /** Optional identifier of the active executable (used to select promoted `.replaceWith()` actors on reboot). */
  readonly executableId?: string;
  /** Optional initial input message frame ID. */
  readonly inputMsgId: string | null;
  /** Optional serialized scope checkpoint captured at the start of the step. */
  readonly baseScopeCheckpoint?: string;
  /** Initial outer-to-inner continuation stack for the step. */
  readonly continuationStack: readonly ContinuationFrame[];
}
