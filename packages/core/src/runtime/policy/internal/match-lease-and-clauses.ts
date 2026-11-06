import type { PolicyGuardClauseNode } from '../../../ast/policy-guard-clause-node.types.js';
import type { PolicyNode } from '../../../ast/policy-node.js';
import type { LeaseDelta } from '../../../ports/lease-delta.js';
import type {
  PendingPreFlightCall,
  RemainingToolCallRecord,
} from '../../../ports/pending-tool-batch.js';
import type { PolicyGuardEvaluationResult } from '../../../ports/runtime-executor-registry.js';
import type { StepExecutionContext } from '../../../ports/step-execution-context.js';
import type { ToolEffect } from '../../../ports/tool-effect.js';
import type { BatchSameClauseInterruptParams } from '../batch-same-clause-interrupt-params.js';
import type { PolicyEvaluationResult } from '../policy-evaluation-result.js';
import type { QuantitativeUsageSnapshot } from '../quantitative-usage-snapshot.js';
import type { SingleGuardClauseEvalParams } from '../single-guard-clause-eval-params.js';

/**
 * Determines whether a single `ToolEffect` is unlocked by any active `LeaseDelta` (`SPEC.md` §3.5).
 *
 * Evaluates each `EffectMatcherASTNode` in `activeLeases` via `ctx.registry.effectMatchers[matcher.type]`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {ToolEffect}                    effect       - Proposed or synthesized tool effect to test.
 * @param {readonly LeaseDelta[]}         activeLeases - Active capability leases granted to the actor or loop.
 * @param {StepExecutionContext<THandle>} ctx          - Step execution context providing `registry.effectMatchers`.
 *
 * @returns {Promise<boolean>} True when at least one active lease matcher covers `effect`.
 */
export async function isEffectCoveredByLeases<THandle = unknown>(
  effect: ToolEffect,
  activeLeases: readonly LeaseDelta[],
  ctx: StepExecutionContext<THandle>,
): Promise<boolean> {
  if (activeLeases.length === 0) return false;
  for (const lease of activeLeases) {
    for (const matcher of lease.grantedMatchers) {
      const matcherExec = ctx.registry.effectMatchers[matcher.type];
      if (matcherExec === undefined) continue;
      const covered = await matcherExec(
        matcher as never,
        effect,
        ctx as StepExecutionContext<unknown>,
      );
      if (covered) return true;
    }
  }
  return false;
}

/**
 * Evaluates all `PolicyGuardASTNode` members of a single `PolicyGuardClauseNode` against `params.proposedEffects`.
 *
 * Filters out any `violatedEffects` that are covered by `params.activeLeases` so elevated capability
 * leases bypass previously blocking guards (`SPEC.md` §3.5).
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {PolicyGuardClauseNode}                clause - Guard clause AST node to evaluate.
 * @param {SingleGuardClauseEvalParams<THandle>} params - Proposed effects, active leases, and execution context.
 *
 * @returns {Promise<PolicyGuardEvaluationResult>} Aggregated evaluation result across all guards in `clause`.
 */
export async function evaluateSingleGuardClause<THandle = unknown>(
  clause: PolicyGuardClauseNode,
  params: SingleGuardClauseEvalParams<THandle>,
): Promise<PolicyGuardEvaluationResult> {
  const uncoveredViolations: ToolEffect[] = [];
  const summaries: string[] = [];
  for (const guardNode of clause.guards) {
    const guardExec = params.ctx.registry.policyGuards[guardNode.type];
    if (guardExec === undefined) {
      throw new Error(`No PolicyGuard executor registered for '${guardNode.type}' in clause '${clause.id}'.`);
    }
    const res = await guardExec(
      guardNode as never,
      { toolName: params.toolName, proposedEffects: params.proposedEffects, activeLeases: params.activeLeases },
      params.ctx as StepExecutionContext<unknown>,
    );
    if (res.allowed) continue;
    let guardHadUncovered = false;
    for (const eff of res.violatedEffects) {
      if (!(await isEffectCoveredByLeases(eff, params.activeLeases, params.ctx))) {
        uncoveredViolations.push(eff);
        guardHadUncovered = true;
      }
    }
    if (guardHadUncovered && res.violationSummary.length > 0) summaries.push(res.violationSummary);
  }
  return Object.freeze<PolicyGuardEvaluationResult>({
    allowed: uncoveredViolations.length === 0,
    violatedEffects: Object.freeze(uncoveredViolations),
    violationSummary: summaries.join('; '),
  });
}

/**
 * Batches trailing tool calls `(i..k)` that pass all `'deny-with-error'` clauses and fail the exact same `'raise-interrupt'` clause $C$.
 *
 * Tags each batched call with `blockedPreFlight: true` and appends `C.id` to `adjudicatedClauseIds` (`SPEC.md` §3.5).
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {BatchSameClauseInterruptParams<THandle>} params - Batching parameters and violated clause $C$.
 *
 * @returns {Promise<PolicyEvaluationResult>} Aggregated `'raise-interrupt'` evaluation result.
 */
export async function batchSameClauseInterrupt<THandle = unknown>(
  params: BatchSameClauseInterruptParams<THandle>,
): Promise<PolicyEvaluationResult> {
  const { batchParams, clause, primaryEffects, primaryEval } = params;
  const blockedCalls: PendingPreFlightCall[] = [];
  const allViolated: ToolEffect[] = [];
  const summaries: string[] = [];
  const updatedRemaining: RemainingToolCallRecord[] = [];
  for (let idx = 0; idx < batchParams.remainingCalls.length; idx += 1) {
    const call = batchParams.remainingCalls[idx];
    if (call === undefined) continue;
    const node = batchParams.toolsByName.get(call.toolName);
    const driver = node !== undefined ? batchParams.ctx.registry.tools[node.type] : undefined;
    let evalRes: PolicyGuardEvaluationResult | undefined = idx === 0 ? primaryEval : undefined;
    if (idx > 0 && node !== undefined && (node as { readonly effectTracking?: string }).effectTracking === 'declared' && driver?.describeEffects !== undefined && call.adjudicatedClauseIds?.includes(clause.id) !== true && batchParams.policy !== undefined) {
      const effects = await driver.describeEffects(node as never, JSON.parse(call.argsJson || '{}'), batchParams.ctx.scopeHandle);
      let denied = false;
      for (const c of batchParams.policy.clauses) {
        if (c.mode === 'deny-with-error' && !(await evaluateSingleGuardClause(c, { toolName: call.toolName, proposedEffects: effects, activeLeases: batchParams.activeLeases, ctx: batchParams.ctx })).allowed) {
          denied = true;
          break;
        }
      }
      if (!denied) evalRes = await evaluateSingleGuardClause(clause, { toolName: call.toolName, proposedEffects: effects, activeLeases: batchParams.activeLeases, ctx: batchParams.ctx });
    }
    if (evalRes !== undefined && !evalRes.allowed) {
      blockedCalls.push(Object.freeze({ callId: call.callId, toolName: call.toolName, argsJson: call.argsJson, violatedEffects: evalRes.violatedEffects, violationSummary: evalRes.violationSummary }));
      for (const eff of evalRes.violatedEffects) allViolated.push(eff);
      if (evalRes.violationSummary.length > 0) summaries.push(evalRes.violationSummary);
      updatedRemaining.push(Object.freeze({ ...call, blockedPreFlight: true, adjudicatedClauseIds: Object.freeze([...(call.adjudicatedClauseIds ?? []), clause.id]) }));
    } else {
      updatedRemaining.push(call);
    }
  }
  const violationSummary = summaries.join('; ');
  const rawPayload = clause.mapViolation({ blockedCalls: Object.freeze(blockedCalls), violatedEffects: Object.freeze(allViolated), violationSummary });
  const interruptPayload = clause.interrupt.schema.parse(rawPayload);
  return Object.freeze<PolicyEvaluationResult>({ status: 'raise-interrupt', primaryEffects, violatedClauseId: clause.id, raisedInterrupt: clause.interrupt, interruptPayload, blockedCalls: Object.freeze(blockedCalls), updatedRemainingCalls: Object.freeze(updatedRemaining) });
}

/**
 * Checks whether quantitative turn, USD cost, or wall-clock duration limits on `policy` have been exceeded.
 *
 * Returns a diagnostic reason string when `maxTurns`, `maxCostUsd`, or `maxDurationSeconds` is breached,
 * or `undefined` when within bounds (`SPEC.md` §3.5).
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {PolicyNode<THandle> | undefined} policy - Optional policy AST node declaring quantitative ceilings.
 * @param {QuantitativeUsageSnapshot}       usage  - Current turn, cost, and elapsed duration counters.
 *
 * @returns {string | undefined} Diagnostic trip reason when a quantitative limit is breached, or `undefined`.
 */
export function checkQuantitativeLimits<THandle = unknown>(
  policy: PolicyNode<THandle> | undefined,
  usage: QuantitativeUsageSnapshot,
): string | undefined {
  if (policy === undefined) return undefined;
  if (policy.maxTurns !== undefined && usage.turnsTaken >= policy.maxTurns) {
    return `Policy '${policy.id}' maxTurns (${String(policy.maxTurns)}) exceeded (${String(usage.turnsTaken)}).`;
  }
  if (policy.maxCostUsd !== undefined && usage.costUsd > policy.maxCostUsd) {
    return `Policy '${policy.id}' maxCostUsd ($${String(policy.maxCostUsd)}) exceeded ($${String(usage.costUsd)}).`;
  }
  if (policy.maxDurationSeconds !== undefined && usage.elapsedDurationMs > policy.maxDurationSeconds * 1_000) {
    return `Policy '${policy.id}' maxDurationSeconds (${String(policy.maxDurationSeconds)}s) exceeded.`;
  }
  return undefined;
}
