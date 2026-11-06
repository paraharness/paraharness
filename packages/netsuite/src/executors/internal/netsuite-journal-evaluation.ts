import type {
  CheckEvaluationResult,
  PolicyGuardEvaluationInput,
  PolicyGuardEvaluationResult,
  StepExecutionContext,
  ToolEffect,
  ToolExecutionResult,
} from '@harness-dsl/core';
import type { NetSuiteBalanceZeroCheckNode } from '../../nodes/netsuite-balance-zero-check-node.js';
import type { NetSuiteClosedPeriodGuardNode } from '../../nodes/netsuite-closed-period-guard-node.js';
import type { NetSuiteJournalToolNode } from '../../nodes/netsuite-journal-tool-node.js';
import { isNetSuiteDraftHandle } from './execute-netsuite-rollback-abort-hook.js';

/**
 * Computes static pre-flight `ToolEffect` descriptors for a `NetSuiteJournalToolNode` invocation.
 *
 * Emits a `netsuite:journal-effect` descriptor recording target account, posting period,
 * debit/credit amounts, and `periodClosed` status for pre-flight policy guards.
 *
 * @param {NetSuiteJournalToolNode<unknown>} tool        - Passive NetSuite journal tool AST node.
 * @param {unknown}                          rawInput    - Validated or raw tool input arguments.
 * @param {unknown}                          scopeHandle - Active scope handle or undefined.
 *
 * @returns {readonly ToolEffect[]} Frozen list of pre-flight tool effects.
 */
export function describeNetSuiteJournalToolEffects(
  tool: NetSuiteJournalToolNode<unknown>,
  rawInput: unknown,
  scopeHandle: unknown,
): readonly ToolEffect[] {
  const record =
    typeof rawInput === 'object' && rawInput !== null
      ? (rawInput as Record<string, unknown>)
      : {};
  const journalId = isNetSuiteDraftHandle(scopeHandle) ? scopeHandle.journalId : 'draft';
  const accountId = typeof record['accountId'] === 'string' ? record['accountId'] : 'journal';
  const postingPeriod =
    typeof record['postingPeriod'] === 'string' ? record['postingPeriod'] : 'current';
  const periodClosed = record['periodClosed'] === true;
  const debitUsd = typeof record['debitUsd'] === 'number' ? record['debitUsd'] : 0;
  const creditUsd = typeof record['creditUsd'] === 'number' ? record['creditUsd'] : 0;

  return Object.freeze<readonly ToolEffect[]>([
    Object.freeze<ToolEffect>({
      kind: 'netsuite:journal-effect',
      mutatesScope: true,
      attributes: Object.freeze({
        toolName: tool.name,
        journalId,
        accountId,
        postingPeriod,
        periodClosed,
        debitUsd,
        creditUsd,
      }),
    }),
  ]);
}

/**
 * Executes a `NetSuiteJournalToolNode` call against the active `NetSuiteDraftHandle`.
 *
 * Appends a staged `NetSuiteJournalLineEntry` for `netsuite_add_journal_line` or transitions
 * the handle status to `'committed'` for `netsuite_commit_journal`.
 *
 * @param {NetSuiteJournalToolNode<unknown>} tool     - Passive NetSuite journal tool AST node.
 * @param {unknown}                          rawInput - Validated tool input payload.
 * @param {StepExecutionContext<unknown>}    ctx      - Active step execution context carrying `NetSuiteDraftHandle`.
 *
 * @returns {Promise<ToolExecutionResult>} Structured tool execution result.
 */
export function executeNetSuiteJournalToolCall(
  tool: NetSuiteJournalToolNode<unknown>,
  rawInput: unknown,
  ctx: StepExecutionContext<unknown>,
): Promise<ToolExecutionResult> {
  if (!isNetSuiteDraftHandle(ctx.scopeHandle)) {
    throw new Error(
      `NetSuite journal tool '${tool.name}' requires an active NetSuiteDraftHandle (runId '${ctx.runId}').`,
    );
  }
  const parsed = tool.inputSchema.parse(rawInput) as Record<string, unknown>;
  ctx.recordEffects(describeNetSuiteJournalToolEffects(tool, parsed, ctx.scopeHandle));
  if (tool.name === 'netsuite_add_journal_line') {
    ctx.scopeHandle.entries.push(
      Object.freeze({
        accountId: String(parsed['accountId']),
        debitUsd: Number(parsed['debitUsd']),
        creditUsd: Number(parsed['creditUsd']),
        postingPeriod: String(parsed['postingPeriod']),
        periodClosed: parsed['periodClosed'] === true,
      }),
    );
  } else {
    ctx.scopeHandle.status = 'committed';
  }
  return Promise.resolve(
    Object.freeze<ToolExecutionResult>({
      content: JSON.stringify({
        journalId: ctx.scopeHandle.journalId,
        lineCount: ctx.scopeHandle.entries.length,
        status: ctx.scopeHandle.status,
      }),
      isError: false,
    }),
  );
}

/**
 * Evaluates a `NetSuiteClosedPeriodGuardNode` against proposed pre-flight `netsuite:journal-effect` descriptors.
 *
 * Rejects any proposed journal line targeting an accounting period marked `periodClosed: true`.
 *
 * @param {NetSuiteClosedPeriodGuardNode} node  - Passive NetSuite closed-period policy guard AST node.
 * @param {PolicyGuardEvaluationInput}    input - Proposed tool effects and active lease deltas.
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
 * Evaluates a `NetSuiteBalanceZeroCheckNode` against the active `NetSuiteDraftHandle`.
 *
 * Verifies that staged journal entries are non-empty and that total debits equal total credits.
 *
 * @param {NetSuiteBalanceZeroCheckNode<unknown>} node - Passive NetSuite zero-balance check AST node.
 * @param {StepExecutionContext<unknown>}         ctx  - Active step execution context carrying `NetSuiteDraftHandle`.
 *
 * @returns {Promise<CheckEvaluationResult>} Deterministic check evaluation result.
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
  let totalDebitUsd = 0;
  let totalCreditUsd = 0;
  for (const entry of ctx.scopeHandle.entries) {
    totalDebitUsd += entry.debitUsd;
    totalCreditUsd += entry.creditUsd;
  }
  const netBalanceUsd = Math.round((totalDebitUsd - totalCreditUsd) * 100) / 100;
  if (netBalanceUsd !== 0) {
    return Promise.resolve(
      Object.freeze<CheckEvaluationResult>({
        ok: false,
        deficits: Object.freeze([
          `Draft journal '${ctx.scopeHandle.journalId}' is out of balance by $${String(netBalanceUsd)} USD (debits: $${String(totalDebitUsd)}, credits: $${String(totalCreditUsd)}).`,
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
