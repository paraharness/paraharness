import type {
  AbortHookExecutionInput,
  CheckEvaluationResult,
  PolicyGuardEvaluationInput,
  PolicyGuardEvaluationResult,
  StepExecutionContext,
  ToolEffect,
} from '@harness-dsl/core';
import type { NetSuiteBalanceZeroCheckNode } from '../../nodes/netsuite-balance-zero-check-node.js';
import type { NetSuiteClosedPeriodGuardNode } from '../../nodes/netsuite-closed-period-guard-node.js';
import type { NetSuiteRollbackAbortHookNode } from '../../nodes/netsuite-rollback-abort-hook-node.js';
import {
  computeNetSuiteJournalTotals,
  isNetSuiteDraftHandle,
} from './compute-netsuite-journal-totals.js';

/**
 * Evaluates a `NetSuiteClosedPeriodGuardNode` against proposed pre-flight `netsuite:journal-effect` descriptors.
 *
 * Rejects any proposed journal line targeting an accounting period marked `periodClosed: true`.
 *
 * @param {NetSuiteClosedPeriodGuardNode} node - Passive NetSuite closed-period policy guard AST node.
 * @param {PolicyGuardEvaluationInput} input - Proposed tool effects and active lease deltas.
 *
 * @returns {Promise<PolicyGuardEvaluationResult>} Policy guard evaluation verdict.
 */
export function evaluateNetSuiteClosedPeriodGuard(
  node: NetSuiteClosedPeriodGuardNode,
  input: PolicyGuardEvaluationInput,
): Promise<PolicyGuardEvaluationResult> {
  const violatedEffects: ToolEffect[] = [];
  for (const effect of input.proposedEffects) {
    if (effect.kind !== 'netsuite:journal-effect') {
      continue;
    }
    if (effect.attributes?.['periodClosed'] === true) {
      violatedEffects.push(effect);
    }
  }
  if (violatedEffects.length === 0) {
    return Promise.resolve(
      Object.freeze<PolicyGuardEvaluationResult>({
        allowed: true,
        violatedEffects: Object.freeze([]),
        violationSummary: '',
      }),
    );
  }
  const firstPeriod = String(violatedEffects[0]?.attributes?.['postingPeriod'] ?? 'unknown');
  return Promise.resolve(
    Object.freeze<PolicyGuardEvaluationResult>({
      allowed: false,
      violatedEffects: Object.freeze(violatedEffects),
      violationSummary: `Policy guard '${node.id}' denied tool '${input.toolName}': posting period '${firstPeriod}' is closed.`,
    }),
  );
}

/**
 * Evaluates a `NetSuiteBalanceZeroCheckNode` against the active `NetSuiteDraftHandle` using exact `big.js` decimal math.
 *
 * Verifies that total debits equal total credits (`!netBalance.abs().eq(0)` triggers a deficit).
 *
 * @param {NetSuiteBalanceZeroCheckNode<unknown>} node - Passive NetSuite zero-balance check AST node.
 * @param {StepExecutionContext<unknown>} ctx - Active step execution context carrying `NetSuiteDraftHandle`.
 *
 * @returns {Promise<CheckEvaluationResult>} Deterministic check evaluation result.
 *
 * @throws {Error} If `ctx.scopeHandle` is not a valid `NetSuiteDraftHandle`.
 */
export function evaluateNetSuiteBalanceZeroCheck(
  node: NetSuiteBalanceZeroCheckNode<unknown>,
  ctx: StepExecutionContext<unknown>,
): Promise<CheckEvaluationResult> {
  if (!isNetSuiteDraftHandle(ctx.scopeHandle)) {
    throw new Error(
      `NetSuite check '${node.id}' requires an active NetSuiteDraftHandle (runId '${ctx.runId}').`,
    );
  }
  const totals = computeNetSuiteJournalTotals(ctx.scopeHandle.entries);
  if (!totals.netBalance.abs().eq(0)) {
    return Promise.resolve(
      Object.freeze<CheckEvaluationResult>({
        ok: false,
        deficits: Object.freeze([
          `Draft journal '${ctx.scopeHandle.journalId}' is out of balance by $${totals.netBalance.toFixed()} USD (debits: $${totals.totalDebit.toFixed()}, credits: $${totals.totalCredit.toFixed()}).`,
        ]),
      }),
    );
  }
  return Promise.resolve(
    Object.freeze<CheckEvaluationResult>({
      ok: true,
      deficits: Object.freeze([]),
    }),
  );
}

/**
 * Executes a `NetSuiteRollbackAbortHookNode` by clearing uncommitted draft journal entries (`netsuite.rollbackDraftJournal`).
 *
 * Empties `handle.entries` in place and transitions `handle.status` to `'rolled-back'` before returning a rollback receipt.
 *
 * @param {NetSuiteRollbackAbortHookNode<unknown>} node - Passive NetSuite rollback abort hook AST node.
 * @param {AbortHookExecutionInput<unknown>} input - Abort hook execution input containing the active scope handle.
 * @param {StepExecutionContext<unknown>} _ctx - Active step execution context.
 *
 * @returns {Promise<Record<string, unknown>>} Rollback receipt summarizing cleared line count and updated handle status.
 *
 * @throws {Error} If `input.handle` is not a valid `NetSuiteDraftHandle`.
 */
export function executeNetSuiteRollbackAbortHook(
  node: NetSuiteRollbackAbortHookNode<unknown>,
  input: AbortHookExecutionInput<unknown>,
  _ctx: StepExecutionContext<unknown>,
): Promise<Record<string, unknown>> {
  if (!isNetSuiteDraftHandle(input.handle)) {
    throw new Error(
      `NetSuite rollback abort hook '${node.id}' requires a valid NetSuiteDraftHandle (runId '${input.runId}', stepExecId '${input.stepExecId}').`,
    );
  }
  const discardedLineCount = input.handle.entries.length;
  input.handle.entries.length = 0;
  input.handle.status = 'rolled-back';
  return Promise.resolve(
    Object.freeze({
      hookId: node.id,
      journalId: input.handle.journalId,
      runId: input.runId,
      stepExecId: input.stepExecId,
      discardedLineCount,
      status: input.handle.status,
    }),
  );
}
