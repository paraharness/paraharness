import type { ReconcileResult } from '../../../src/ports/reconcile-result.types.js';
import type { ScriptedBranchableScope } from '../scripted-branchable-scope.js';

/**
 * Reconciles `child` into `parent` on `scope`, returning a conflict when `commitConflictRemainingCount > 0`.
 *
 * Decrements `commitConflictRemainingCount` on each conflicted attempt and merges `child` state on clean reconciliation.
 *
 * @param {ScriptedBranchableScope} scope  - Owning scripted branchable scope fixture.
 * @param {string}                  child  - Completed child scope handle.
 * @param {string}                  parent - Target parent scope handle.
 *
 * @returns {ReconcileResult<Record<string, unknown>>} Clean or conflicted reconciliation result.
 */
export function commitScriptedChild(
  scope: ScriptedBranchableScope,
  child: string,
  parent: string,
): ReconcileResult<Record<string, unknown>> {
  if (scope.commitConflictRemainingCount > 0) {
    scope.commitConflictRemainingCount -= 1;
    return Object.freeze({
      status: 'conflict',
      conflictedSummary: `Conflict merging ${child} into ${parent}`,
      data: { child, parent, conflictedUnits: ['src/conflicted.ts'] },
    });
  }
  const merged = { ...(scope.handleState.get(parent) ?? {}), ...(scope.handleState.get(child) ?? {}), handle: parent, lastCommittedChild: child };
  scope.handleState.set(parent, merged);
  return Object.freeze({ status: 'clean', data: merged });
}

/**
 * Synchronizes `pausedChild` onto `parent` on `scope`, returning a conflict when `syncChildConflictRemainingCount > 0`.
 *
 * Decrements `syncChildConflictRemainingCount` on each conflicted attempt.
 *
 * @param {ScriptedBranchableScope} scope       - Owning scripted branchable scope fixture.
 * @param {string}                  parent      - Updated parent scope handle.
 * @param {string}                  pausedChild - Suspended child scope handle.
 *
 * @returns {ReconcileResult<Record<string, unknown>>} Clean or conflicted sync result.
 */
export function syncScriptedChild(
  scope: ScriptedBranchableScope,
  parent: string,
  pausedChild: string,
): ReconcileResult<Record<string, unknown>> {
  if (scope.syncChildConflictRemainingCount > 0) {
    scope.syncChildConflictRemainingCount -= 1;
    return Object.freeze({
      status: 'conflict',
      conflictedSummary: `Sync conflict on ${pausedChild}`,
      data: { parent, pausedChild },
    });
  }
  return Object.freeze({ status: 'clean', data: { parent, pausedChild, synced: true } });
}

/**
 * Synchronizes `rootHandle` onto `prerequisiteReceipts` on `scope`, returning a conflict when `syncRootConflictRemainingCount > 0`.
 *
 * Records `syncedPrerequisiteCount` on `rootHandle`'s state map when clean.
 *
 * @param {ScriptedBranchableScope}            scope                - Owning scripted branchable scope fixture.
 * @param {string}                             rootHandle           - Task root scope handle.
 * @param {readonly Record<string, unknown>[]} prerequisiteReceipts - Prerequisite terminal receipts.
 *
 * @returns {ReconcileResult<Record<string, unknown>>} Clean or conflicted sync result.
 */
export function syncScriptedRoot(
  scope: ScriptedBranchableScope,
  rootHandle: string,
  prerequisiteReceipts: readonly Record<string, unknown>[],
): ReconcileResult<Record<string, unknown>> {
  if (scope.syncRootConflictRemainingCount > 0) {
    scope.syncRootConflictRemainingCount -= 1;
    return Object.freeze({
      status: 'conflict',
      conflictedSummary: `Root sync conflict on ${rootHandle}`,
      data: { rootHandle },
    });
  }
  scope.handleState.set(rootHandle, { ...(scope.handleState.get(rootHandle) ?? {}), syncedPrerequisiteCount: prerequisiteReceipts.length });
  return Object.freeze({ status: 'clean', data: { rootHandle, prerequisiteCount: prerequisiteReceipts.length } });
}
