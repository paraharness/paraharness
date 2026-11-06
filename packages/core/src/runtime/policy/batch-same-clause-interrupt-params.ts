import type { RaiseInterruptPolicyGuardClauseNode } from '../../ast/raise-interrupt-policy-guard-clause-node.js';
import type { PolicyGuardEvaluationResult } from '../../ports/runtime-executor-registry.js';
import type { ToolEffect } from '../../ports/tool-effect.js';
import type { PreFlightBatchEvalParams } from './pre-flight-batch-eval-params.js';

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
