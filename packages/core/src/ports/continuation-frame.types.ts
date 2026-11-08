import type { AgentContinuationFrame } from './agent-continuation-frame.js';
import type { ForkBatchContinuationFrame } from './fork-batch-continuation-frame.js';
import type { LoopContinuationFrame } from './loop-continuation-frame.js';
import type { SpeculateContinuationFrame } from './speculate-continuation-frame.js';

/**
 * Discriminated union of serialized tree-structured execution frames persisted in `LedgerStore`.
 *
 * Preserves composite `M.loop`, `M.agent`, downward `.fork()` / `resumeFork` batches, and
 * `.speculate()` tournaments across upward interrupt suspensions and process crash recovery.
 */
export type ContinuationFrame =
  | AgentContinuationFrame
  | LoopContinuationFrame
  | ForkBatchContinuationFrame
  | SpeculateContinuationFrame;
