import type { PolicyNode } from '../../ast/policy-node.js';
import type { PendingPreFlightCall } from '../../ports/pending-tool-batch.js';
import type {
  QuotaTripwireEvaluationInput,
  QuotaTripwireEvaluationResult,
} from '../../ports/runtime-executor-registry.js';
import type { StepExecutionContext } from '../../ports/step-execution-context.js';
import type { ToolEffect } from '../../ports/tool-effect.js';
import {
  batchSameClauseInterrupt,
  evaluateSingleGuardClause,
} from './internal/match-lease-and-clauses.js';
import type {
  PolicyEvaluationResult,
  PreFlightBatchEvalParams,
} from './policy-evaluation-result.js';
import type {
  PostFlightSandboxParams,
  PostFlightSandboxResult,
} from './post-flight-sandbox-params.js';

/**
 * Evaluates two-phase policy guards (`'deny-with-error'` before `'raise-interrupt'`) across `remainingCalls` (`SPEC.md` §3.5).
 *
 * When call `0` fails a `'raise-interrupt'` clause $C$, inspects trailing `'declared'` calls `(0..k)`
 * and batches into `blockedCalls` all calls that pass every `'deny-with-error'` clause and fail the exact same clause $C$.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {PreFlightBatchEvalParams<THandle>} params            - Pre-flight batch evaluation parameters.
 * @param {readonly ToolEffect[]}             [overrideEffects] - Optional pre-computed effects for call `0`.
 *
 * @returns {Promise<PolicyEvaluationResult>} Policy evaluation decision and batched blocked calls.
 */
export async function evaluatePreFlightToolBatch<THandle = unknown>(
  params: PreFlightBatchEvalParams<THandle>,
  overrideEffects?: readonly ToolEffect[],
): Promise<PolicyEvaluationResult> {
  const primary = params.remainingCalls[0];
  if (primary === undefined) {
    return Object.freeze<PolicyEvaluationResult>({ status: 'allowed', primaryEffects: overrideEffects ?? Object.freeze([]) });
  }
  const primaryNode = params.toolsByName.get(primary.toolName);
  const primaryDriver = primaryNode !== undefined ? params.ctx.registry.tools[primaryNode.type] : undefined;
  const primaryEffects = overrideEffects ?? (primaryNode !== undefined && primaryDriver?.describeEffects !== undefined
    ? await primaryDriver.describeEffects(primaryNode as never, JSON.parse(primary.argsJson || '{}'), params.ctx.scopeHandle)
    : Object.freeze([]));
  if (params.policy === undefined) {
    return Object.freeze<PolicyEvaluationResult>({ status: 'allowed', primaryEffects });
  }
  for (const clause of params.policy.clauses) {
    if (clause.mode !== 'deny-with-error') continue;
    const res = await evaluateSingleGuardClause(clause, { toolName: primary.toolName, proposedEffects: primaryEffects, activeLeases: params.activeLeases, ctx: params.ctx });
    if (!res.allowed) {
      const blocked: PendingPreFlightCall = Object.freeze({ callId: primary.callId, toolName: primary.toolName, argsJson: primary.argsJson, violatedEffects: res.violatedEffects, violationSummary: res.violationSummary });
      const msg = clause.messageMapper !== undefined ? clause.messageMapper({ blockedCalls: [blocked], violatedEffects: res.violatedEffects, violationSummary: res.violationSummary }) : res.violationSummary;
      return Object.freeze<PolicyEvaluationResult>({ status: 'denied-with-error', primaryEffects, violatedClauseId: clause.id, deniedErrorMessage: msg });
    }
  }
  for (const clause of params.policy.clauses) {
    if (clause.mode !== 'raise-interrupt') continue;
    const res = await evaluateSingleGuardClause(clause, { toolName: primary.toolName, proposedEffects: primaryEffects, activeLeases: params.activeLeases, ctx: params.ctx });
    if (!res.allowed) {
      return batchSameClauseInterrupt({ batchParams: params, clause, primaryEffects, primaryEval: res });
    }
  }
  return Object.freeze<PolicyEvaluationResult>({ status: 'allowed', primaryEffects });
}

/**
 * Executes a `'subprocess-post-flight'` tool inside a checkpointed sandbox (`SPEC.md` §3.5).
 *
 * Serializes `inFlightPreToolCheckpoint` before running the subprocess, restores the checkpoint
 * on throw/abort or post-flight guard rejection, and records effects only when permitted.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {PostFlightSandboxParams<THandle>} params - Post-flight sandbox parameters and checkpoint scope.
 *
 * @returns {Promise<PostFlightSandboxResult>} Execution result and post-flight verification status.
 */
export async function executePostFlightSandboxedTool<THandle = unknown>(
  params: PostFlightSandboxParams<THandle>,
): Promise<PostFlightSandboxResult> {
  const preToolCkpt = await params.checkpointScope.serializeCheckpoint(params.ctx.scopeHandle);
  await params.persistInFlightCheckpoint(preToolCkpt);
  let rawResult;
  try {
    params.ctx.signal?.throwIfAborted();
    rawResult = await params.toolDriver.execute(params.toolNode, params.parsedArgs, params.ctx);
    params.ctx.signal?.throwIfAborted();
  } catch (err) {
    await params.checkpointScope.restoreCheckpoint(params.ctx.scopeHandle, preToolCkpt);
    await params.persistInFlightCheckpoint(undefined);
    throw err;
  }
  const synthesizedEffects = await params.checkpointScope.diffEffects(preToolCkpt, params.ctx.scopeHandle);
  const toolsMap = new Map([[params.callRecord.toolName, params.toolNode]]);
  const policyRes = await evaluatePreFlightToolBatch(
    { policy: params.policy, remainingCalls: [params.callRecord], toolsByName: toolsMap, activeLeases: params.activeLeases, ctx: params.ctx },
    synthesizedEffects,
  );
  if (policyRes.status !== 'allowed') {
    await params.checkpointScope.restoreCheckpoint(params.ctx.scopeHandle, preToolCkpt);
    await params.persistInFlightCheckpoint(undefined);
    const errText = policyRes.deniedErrorMessage ?? `Post-flight policy violation (${policyRes.violatedClauseId ?? 'guard'}): rolled back subprocess changes.`;
    return Object.freeze<PostFlightSandboxResult>({
      status: policyRes.status === 'denied-with-error' ? 'rolled-back-error' : 'rolled-back-interrupt',
      toolResult: Object.freeze({ content: errText, isError: true }),
      synthesizedEffects,
      policyResult: policyRes,
    });
  }
  params.ctx.recordEffects(synthesizedEffects);
  await params.persistInFlightCheckpoint(undefined);
  return Object.freeze<PostFlightSandboxResult>({ status: 'allowed', toolResult: rawResult, synthesizedEffects });
}

/**
 * Evaluates all `QuotaTripwireASTNode` instances on `policy` after a tool execution (`SPEC.md` §3.5).
 *
 * Returns the first tripped quota tripwire result, or `{ tripped: false }` when all tripwires pass.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {PolicyNode<THandle> | undefined} policy - Active policy AST node.
 * @param {QuotaTripwireEvaluationInput}    input  - Accumulated and newly observed tool effects.
 * @param {StepExecutionContext<THandle>}   ctx    - Step execution context.
 *
 * @returns {Promise<QuotaTripwireEvaluationResult>} Tripwire evaluation result.
 */
export async function evaluateQuotaTripwires<THandle = unknown>(
  policy: PolicyNode<THandle> | undefined,
  input: QuotaTripwireEvaluationInput,
  ctx: StepExecutionContext<THandle>,
): Promise<QuotaTripwireEvaluationResult> {
  if (policy === undefined || policy.tripwires.length === 0) {
    return Object.freeze<QuotaTripwireEvaluationResult>({ tripped: false });
  }
  for (const tripwire of policy.tripwires) {
    const exec = ctx.registry.quotaTripwires[tripwire.type];
    if (exec === undefined) {
      throw new Error(`No QuotaTripwire executor registered for '${tripwire.type}' in policy '${policy.id}'.`);
    }
    const res = await exec(tripwire as never, input, ctx as StepExecutionContext<unknown>);
    if (res.tripped) return res;
  }
  return Object.freeze<QuotaTripwireEvaluationResult>({ tripped: false });
}
