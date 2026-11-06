import type { ActiveTurnPauseState } from './active-turn-pause-state.js';
import type { AdjudicationPauseState } from './adjudication-pause-state.js';
import type { BeforeStopGatePauseState } from './before-stop-gate-pause-state.js';
import type { InterruptFlushPauseState } from './interrupt-flush-pause-state.js';
import type { PrerequisiteWaitPauseState } from './prerequisite-wait-pause-state.js';
import type { ToolBatchPauseState } from './tool-batch-pause-state.js';

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
