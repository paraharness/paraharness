import type { LeaseDelta } from './lease-delta.js';
import type { LessonOutcome } from './lesson-outcome.types.js';
import type { ToolEffect } from './tool-effect.js';

/**
 * Recalled lesson summary persisted on `LoopContinuationFrame` and forwarded into `.evaluate()`.
 *
 * Preserves the lesson identifier, optional partition tag, and preventative directive across iterations.
 */
export interface RecalledLoopLessonRecord {
  /** Unique identifier of the recalled lesson. */
  readonly id: string;
  /** Optional partition identifier associated with the lesson. */
  readonly partition?: string;
  /** Preventative directive text of the lesson. */
  readonly directive: string;
}

/**
 * Serialized continuation frame for an iterative `P.loop` execution (`kind: 'loop-frame'`).
 *
 * Preserves cumulative telemetry, `.act()`-only tripwire counters, loop-scoped capability leases
 * (`grantedLoopLeases`), active skills, and deduplicated lesson outcome attribution across
 * iterations, cross-model escalations, and fork suspensions.
 */
export interface LoopContinuationFrame {
  /** Discriminant identifying a loop continuation frame. */
  readonly kind: 'loop-frame';
  /** Logical identifier of the `LoopNode`. */
  readonly loopId: string;
  /** Canonical `roleKey` of the loop's `.act()` actor. */
  readonly roleKey: string;
  /** Provider model identifier used on the most recent `.act()` iteration. */
  readonly lastActModelId?: string;
  /** Unique step execution identifier in `LedgerStore`. */
  readonly stepExecId: string;
  /** JSON-serialized validated input payload for the loop. */
  readonly loopInputJson: string;
  /** Zero-based current iteration index (`0..maxIterations - 1`). */
  readonly iteration: number;
  /** Active phase within the current iteration (`'act'` vs `'evaluate'`). */
  readonly phase: 'act' | 'evaluate';
  /** Leaf message ID of the `.act()` actor's structured-output completion turn. */
  readonly preservedActLeafMessageId: string | null;
  /** JSON-serialized `.act()` output persisted when transitioning to `phase: 'evaluate'`. */
  readonly lastActOutputJson?: string;
  /** JSON-serialized scope receipt persisted when transitioning to `phase: 'evaluate'`. */
  readonly lastActScopeReceiptJson?: string;
  /** Cumulative total LLM turns across both `.act()` and `.evaluate()` iterations. */
  readonly turnsTaken: number;
  /** Cumulative total USD cost across both `.act()` and `.evaluate()` iterations. */
  readonly costUsd: number;
  /** Cumulative total elapsed duration in milliseconds across the loop. */
  readonly elapsedDurationMs: number;
  /** Cumulative `.act()`-only LLM turns evaluated against the `.act()` actor's `P.policy.maxTurns`. */
  readonly actTurnsTaken: number;
  /** Cumulative `.act()`-only USD cost evaluated against the `.act()` actor's `P.policy.maxCostUsd`. */
  readonly actCostUsd: number;
  /** Cumulative `.act()`-only elapsed duration in milliseconds evaluated against `P.policy.maxDurationSeconds`. */
  readonly actElapsedDurationMs: number;
  /** Loop-scoped capability leases inherited across all `.act()` iterations. */
  readonly grantedLoopLeases: readonly LeaseDelta[];
  /** Active skill IDs mounted by the `.act()` actor across iterations. */
  readonly activeSkillIds: readonly string[];
  /** Map of `.act()` active `skillId` to its `{ messageId, callId }` activation coordinates. */
  readonly activeSkillActivations: Readonly<
    Record<string, { readonly messageId: string; readonly callId: string }>
  >;
  /** Cumulative `ToolEffect` descriptors recorded across the loop. */
  readonly observedEffects: readonly ToolEffect[];
  /** Identifiers of `ScopedRuleNode` directives injected into the `.act()` actor across iterations. */
  readonly injectedScopedRuleIds: readonly string[];
  /** Whether `scopeNode.conflictCleanCheck` is armed on the loop's scope handle. */
  readonly conflictCheckArmed?: boolean;
  /** Active lessons recalled at loop start and forwarded to `.evaluate()`. */
  readonly recalledLessons: readonly RecalledLoopLessonRecord[];
  /** Optional JSON-serialized snapshot of the most recent rejected iteration for `.onLoopRecovery()`. */
  readonly lastRejectedIterationJson?: string;
  /** Buffered gate recovery pairs awaiting `.evaluate()` acceptance before distillation. */
  readonly bufferedGateRecoveries?: readonly unknown[];
  /** Per-loop deduplicated lesson outcome map (`lessonId` -> worst 4-state outcome observed). */
  readonly accumulatedLessonOutcomes: Readonly<Record<string, LessonOutcome>>;
}
