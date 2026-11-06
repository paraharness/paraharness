import type { AbortHookExecutionInput, StepExecutionContext } from '@harness-dsl/core';
import type { NetSuiteDraftHandle } from '../../nodes/netsuite-draft-handle.js';
import type { NetSuiteRollbackAbortHookNode } from '../../nodes/netsuite-rollback-abort-hook-node.js';

/**
 * Type predicate verifying that an opaque runtime scope handle conforms to `NetSuiteDraftHandle`.
 *
 * Checks that `candidate` is a non-null object carrying string `runId` and `journalId` fields
 * and an `entries` array.
 *
 * @param {unknown} candidate - Opaque scope handle value to inspect.
 *
 * @returns {boolean} `true` when `candidate` is a valid `NetSuiteDraftHandle`.
 */
export function isNetSuiteDraftHandle(candidate: unknown): candidate is NetSuiteDraftHandle {
  if (typeof candidate !== 'object' || candidate === null) {
    return false;
  }
  const record = candidate as Record<string, unknown>;
  return (
    typeof record['runId'] === 'string' &&
    typeof record['journalId'] === 'string' &&
    Array.isArray(record['entries'])
  );
}

/**
 * Executes a `NetSuiteRollbackAbortHookNode` by clearing uncommitted draft journal entries (`netsuite.rollbackDraftJournal`).
 *
 * Empties `handle.entries` in place and transitions `handle.status` to `'rolled-back'` before returning a rollback receipt.
 *
 * @param {NetSuiteRollbackAbortHookNode<unknown>} node  - Passive NetSuite rollback abort hook AST node.
 * @param {AbortHookExecutionInput<unknown>}       input - Abort hook execution input containing the active scope handle.
 * @param {StepExecutionContext<unknown>}          _ctx  - Active step execution context.
 *
 * @returns {Promise<Record<string, unknown>>} Rollback receipt summarizing cleared line count and updated handle status.
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
