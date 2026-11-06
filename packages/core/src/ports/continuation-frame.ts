import type { AgentContinuationFrame } from './agent-continuation-frame.js';
import type { ForkBatchContinuationFrame } from './fork-batch-continuation-frame.js';
import type { LoopContinuationFrame } from './loop-continuation-frame.js';
import type { SpeculateContinuationFrame } from './speculate-continuation-frame.js';

export type { AgentContinuationFrame } from './agent-continuation-frame.js';
export type {
  ForkBatchContinuationFrame,
  ForkBatchEntryRecord,
  PendingPauseTriggerRecord,
} from './fork-batch-continuation-frame.js';
export type { LoopContinuationFrame, RecalledLoopLessonRecord } from './loop-continuation-frame.js';
export type {
  SpeculateBranchEntryRecord,
  SpeculateBufferedLessonOutcomeRecord,
  SpeculateContinuationFrame,
  SpeculateHumanRulingRecord,
} from './speculate-continuation-frame.js';

/**
 * Discriminated union of serialized tree-structured execution frames persisted in `LedgerStore`.
 *
 * Preserves composite `H.loop`, `H.agent`, downward `.fork()` / `resumeFork` batches, and
 * `.speculate()` tournaments across upward interrupt suspensions and process crash recovery.
 */
export type ContinuationFrame =
  | AgentContinuationFrame
  | LoopContinuationFrame
  | ForkBatchContinuationFrame
  | SpeculateContinuationFrame;
