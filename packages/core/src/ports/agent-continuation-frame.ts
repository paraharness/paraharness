import type { AgentPauseState } from './agent-pause-state.js';
import type { LeaseDelta } from './lease-delta.js';
import type { LessonOutcome } from './lesson-outcome.types.js';
import type { ToolEffect } from './tool-effect.js';

/**
 * Serialized continuation frame for an `H.agent` execution session (`kind: 'agent-frame'`).
 *
 * Persisted inside `ContinuationFrame[]` stacks in `LedgerStore` and `SuspendedForkRecord`
 * to support deterministic crash recovery, sibling-interrupt suspension, and `resumeFork`.
 */
export interface AgentContinuationFrame {
  /** Discriminant identifying an agent continuation frame. */
  readonly kind: 'agent-frame';
  /** Logical identifier of the `AgentNode`. */
  readonly agentId: string;
  /** Canonical order-independent `roleKey` selecting the actor's wire toolset. */
  readonly roleKey: string;
  /** Provider model identifier used by the active session. */
  readonly modelId: string;
  /** Unique step execution identifier in `LedgerStore`. */
  readonly stepExecId: string;
  /** JSON-serialized validated input payload for the agent session. */
  readonly inputJson: string;
  /** Identifier of the latest persisted `WireFrameRecord` in the session transcript, or `null`. */
  readonly leafMessageId: string | null;
  /** Cumulative number of LLM turns completed in this agent session. */
  readonly turnsTaken: number;
  /** Cumulative model invocation cost in USD for this agent session. */
  readonly costUsd: number;
  /** Cumulative elapsed execution time in milliseconds for this agent session. */
  readonly elapsedDurationMs: number;
  /** Active capability leases granted to this agent session. */
  readonly activeLeases: readonly LeaseDelta[];
  /** Identifiers of skills currently mounted via `activateSkill` in this session. */
  readonly activeSkillIds: readonly string[];
  /** Map of active `skillId` to its `{ messageId, callId }` activation frame coordinates for `completeSkill`. */
  readonly activeSkillActivations: Readonly<
    Record<string, { readonly messageId: string; readonly callId: string }>
  >;
  /** Cumulative `ToolEffect` descriptors recorded during this session. */
  readonly observedEffects: readonly ToolEffect[];
  /** Identifiers of `ScopedRuleNode` directives already injected into this session. */
  readonly injectedScopedRuleIds: readonly string[];
  /** High-level execution boundary at which the session is currently paused. */
  readonly pausedAtPhase: 'TOOL_BOUNDARY' | 'BEFORE_STOP_GATE' | 'LIMIT_EXCEEDED_FLUSH';
  /** Phase-specific discriminated pause payload. */
  readonly pauseState: AgentPauseState;
  /** Whether `scopeNode.conflictCleanCheck` is armed due to a prior conflicted merge or rebase. */
  readonly conflictCheckArmed?: boolean;
  /** Whether the next completion check follows a neutral `[TOPOLOGY_SYNC_REVERIFY]` continuation. */
  readonly neutralSyncContinuation?: boolean;
  /** Checkpoint marker set during `'SUSPENDED'` prerequisite wakeup once `syncRoot` is persisted. */
  readonly syncedToPrerequisiteCheckpoint?: string;
  /** Optional JSON-serialized snapshot of the most recent `beforeStop` gate failure for `.onGateRecovery()`. */
  readonly lastGateFailureJson?: string;
  /** Buffered in-session gate recovery pairs awaiting loop acceptance and winner commit before distillation. */
  readonly bufferedGateRecoveries?: readonly unknown[];
  /** Deduplicated per-lesson 4-state outcome map accumulated during standalone agent execution. */
  readonly accumulatedLessonOutcomes?: Readonly<Record<string, LessonOutcome>>;
}
