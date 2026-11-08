import type { CheckEvaluationResult, StepExecutionContext } from '@paraharness/core';
import type { NetSuiteBalanceZeroCheckNode } from '../../nodes/netsuite-balance-zero-check-node.js';
import { computeNetSuiteJournalTotals } from './compute-netsuite-journal-totals.js';
import { isNetSuiteDraftHandle } from './is-netsuite-draft-handle.js';

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
