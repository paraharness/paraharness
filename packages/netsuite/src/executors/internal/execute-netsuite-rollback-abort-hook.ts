import type { AbortHookExecutionInput, StepExecutionContext } from '@metaharness/core';
import type { NetSuiteRollbackAbortHookNode } from '../../nodes/netsuite-rollback-abort-hook-node.js';
import { isNetSuiteDraftHandle } from './is-netsuite-draft-handle.js';

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
