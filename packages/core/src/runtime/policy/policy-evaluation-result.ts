import type { ToolASTNode } from '../../ast/domain-ast.types.js';
import type { InterruptNode } from '../../ast/interrupt-node.js';
import type { PolicyNode } from '../../ast/policy-node.js';
import type { RaiseInterruptPolicyGuardClauseNode } from '../../ast/raise-interrupt-policy-guard-clause-node.js';
import type { LeaseDelta } from '../../ports/lease-delta.js';
import type {
  PendingPreFlightCall,
  RemainingToolCallRecord,
} from '../../ports/pending-tool-batch.js';
import type { PolicyGuardEvaluationResult } from '../../ports/runtime-executor-registry.js';
import type { StepExecutionContext } from '../../ports/step-execution-context.js';
import type { ToolEffect } from '../../ports/tool-effect.js';

/**
 * Parameters for batching trailing tool calls `(i..k)` that fail the exact same `'raise-interrupt'` clause $C$.
 *
 * Supplies the pre-flight batch evaluation context, the violated `'raise-interrupt'` clause,
 * and the primary call's effects and guard evaluation result.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface BatchSameClauseInterruptParams<THandle = unknown> {
  /** Pre-flight batch evaluation parameters for `(i..k)`. */
  readonly batchParams: PreFlightBatchEvalParams<THandle>;
  /** Violated `'raise-interrupt'` guard clause $C$. */
  readonly clause: RaiseInterruptPolicyGuardClauseNode<unknown>;
  /** Primary call's predicted or synthesized `ToolEffect` list. */
  readonly primaryEffects: readonly ToolEffect[];
  /** Guard evaluation result for the primary call at index `0`. */
  readonly primaryEval: PolicyGuardEvaluationResult;
}

/**
 * Parameters for evaluating a single policy guard clause against proposed tool effects.
 *
 * Supplies the tool name, proposed effects, active capability leases, and step execution context.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface SingleGuardClauseEvalParams<THandle = unknown> {
  /** Wire-level name of the tool being evaluated. */
  readonly toolName: string;
  /** Proposed pre-flight or post-flight tool effects. */
  readonly proposedEffects: readonly ToolEffect[];
  /** Active capability leases (`agent-frame.activeLeases` unioned with `loop-frame.grantedLoopLeases`). */
  readonly activeLeases: readonly LeaseDelta[];
  /** Step execution context providing `registry.policyGuards` and `registry.effectMatchers`. */
  readonly ctx: StepExecutionContext<THandle>;
}

/**
 * Parameters for evaluating pre-flight policy guards across a pending tool call batch `(i..k)`.
 *
 * Supplies the active `PolicyNode`, remaining tool calls starting at index `i`, registered tool nodes,
 * active capability leases, and step execution context.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface PreFlightBatchEvalParams<THandle = unknown> {
  /** Active policy AST node governing tool execution, or `undefined` when unguarded. */
  readonly policy: PolicyNode<THandle> | undefined;
  /** Unfinished tool calls `(i..k)` starting with the currently inspected call at index `0`. */
  readonly remainingCalls: readonly RemainingToolCallRecord[];
  /** Map of tool name to passive `ToolASTNode` mounted on the actor or unlocked by active skills. */
  readonly toolsByName: ReadonlyMap<string, ToolASTNode<THandle>>;
  /** Active capability leases (`agent-frame.activeLeases` unioned with `loop-frame.grantedLoopLeases`). */
  readonly activeLeases: readonly LeaseDelta[];
  /** Step execution context providing `scopeHandle` and `registry`. */
  readonly ctx: StepExecutionContext<THandle>;
}

/**
 * Quantitative turn, cost, and duration counters checked against `PolicyNode` ceilings.
 *
 * In `H.loop`, populated from `.act()`-only counters (`actTurnsTaken`, `actCostUsd`, `actElapsedDurationMs`).
 */
export interface QuantitativeUsageSnapshot {
  /** Number of LLM turns taken so far. */
  readonly turnsTaken: number;
  /** Cumulative USD cost incurred so far. */
  readonly costUsd: number;
  /** Cumulative elapsed duration in milliseconds so far. */
  readonly elapsedDurationMs: number;
}

/**
 * Result of evaluating pre-flight or post-flight policy guard clauses (`SPEC.md` §3.5).
 *
 * Distinguishes clean passage (`'allowed'`), in-band denial (`'denied-with-error'`), and
 * batched or single-call interrupt escalation (`'raise-interrupt'`).
 */
export interface PolicyEvaluationResult {
  /** Outcome status of the policy guard evaluation. */
  readonly status: 'allowed' | 'denied-with-error' | 'raise-interrupt';
  /**Predicted or synthesized `ToolEffect` descriptors for the primary evaluated tool call. */
  readonly primaryEffects: readonly ToolEffect[];
  /** Identifier of the violated guard clause when `status !== 'allowed'`. */
  readonly violatedClauseId?: string;
  /** Formatted in-band error message when `status === 'denied-with-error'`. */
  readonly deniedErrorMessage?: string;
  /** Raised `InterruptNode` when `status === 'raise-interrupt'`. */
  readonly raisedInterrupt?: InterruptNode<unknown>;
  /** Validated interrupt payload produced by `clause.mapViolation` when `status === 'raise-interrupt'`. */
  readonly interruptPayload?: unknown;
  /** Batched blocked calls failing the exact same `'raise-interrupt'` clause $C$. */
  readonly blockedCalls?: readonly PendingPreFlightCall[];
  /** Updated `remainingCalls` `(i..k)` with `blockedPreFlight: true` and `adjudicatedClauseIds` tagged on batched calls. */
  readonly updatedRemainingCalls?: readonly RemainingToolCallRecord[];
  /** Optional reference to single-clause parameters for property reachability. */
  readonly singleClauseTemplate?: SingleGuardClauseEvalParams<unknown>;
  /** Optional reference to pre-flight batch parameters for property reachability. */
  readonly batchParamsTemplate?: PreFlightBatchEvalParams<unknown>;
  /** Optional reference to quantitative usage snapshot for property reachability. */
  readonly quantitativeTemplate?: QuantitativeUsageSnapshot;
  /** Optional reference to batch interrupt parameters for property reachability. */
  readonly batchInterruptTemplate?: BatchSameClauseInterruptParams<unknown>;
}
