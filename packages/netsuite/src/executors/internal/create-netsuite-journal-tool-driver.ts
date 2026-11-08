import type {
  StepExecutionContext,
  ToolDriver,
  ToolEffect,
  ToolExecutionResult,
} from '@metaharness/core';
import type { NetSuiteJournalLineEntry } from '../../nodes/netsuite-draft-handle.js';
import type { NetSuiteJournalToolNode } from '../../nodes/netsuite-journal-tool-node.js';
import { isNetSuiteDraftHandle } from './is-netsuite-draft-handle.js';

/**
 * Computes static pre-flight `ToolEffect` descriptors for a `NetSuiteJournalToolNode` invocation.
 *
 * Emits a `netsuite:journal-effect` descriptor recording target account, posting period,
 * debit/credit amounts, and `periodClosed` status for pre-flight policy guards.
 *
 * @param {NetSuiteJournalToolNode<unknown>} tool - Passive NetSuite journal tool AST node.
 * @param {unknown} rawInput - Validated or raw tool input arguments.
 * @param {unknown} scopeHandle - Active scope handle or undefined.
 *
 * @returns {readonly ToolEffect[]} Frozen list of pre-flight tool effects.
 */
function describeNetSuiteJournalToolEffects(
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
 * @param {NetSuiteJournalToolNode<unknown>} tool - Passive NetSuite journal tool AST node.
 * @param {unknown} rawInput - Validated tool input payload.
 * @param {StepExecutionContext<unknown>} ctx - Active step execution context carrying `NetSuiteDraftHandle`.
 *
 * @returns {Promise<ToolExecutionResult>} Structured tool execution result.
 *
 * @throws {Error} If `ctx.scopeHandle` is not an active `NetSuiteDraftHandle` or if `rawInput` fails schema validation.
 */
function executeNetSuiteJournalToolCall(
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
      Object.freeze<NetSuiteJournalLineEntry>({
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
 * Creates the `ToolDriver<NetSuiteJournalToolNode<unknown>>` registered under `'netsuite:journal-tool'`.
 *
 * Binds `describeNetSuiteJournalToolEffects` for pre-flight policy inspection and `executeNetSuiteJournalToolCall` for tool execution.
 *
 * @returns {ToolDriver<NetSuiteJournalToolNode<unknown>>} Frozen tool driver for NetSuite draft journal operations.
 */
export function createNetSuiteJournalToolDriver(): ToolDriver<NetSuiteJournalToolNode<unknown>> {
  return Object.freeze<ToolDriver<NetSuiteJournalToolNode<unknown>>>({
    describeEffects: describeNetSuiteJournalToolEffects,
    execute: executeNetSuiteJournalToolCall,
  });
}
