import { BudgetApprovalSchema } from '../../../schemas/budget-and-lesson.schema.js';
import { executeHierarchicalRewindDrain } from '../../flow/internal/flow-replace-and-rewind.js';
import type { LaneQueuedItemState } from '../lane-queued-item-state.js';
import type { LaneSchedulerConfig } from '../lane-scheduler-config.js';

/**
 * Evaluates and enforces `.maxCostUsd(limitUsd, approver)` for `item` (`SPEC.md` §3.10).
 *
 * Pages `approver` via `HumanAdapter.requestDecision` and either raises `approvedMaxCostUsd` (when `nextLimit > item.costUsd`) or cancels the run.
 *
 * @template TIn Validated lane work item input type.
 *
 * @param {LaneSchedulerConfig<TIn>}                          cfg         - Lane scheduler configuration.
 * @param {LaneQueuedItemState<TIn>}                          item        - Tracked lane item state.
 * @param {(itemKey: string, state: string) => Promise<void>} syncTracker - Callback mirroring terminal `'cancelled'` state to `TrackerAdapter`.
 *
 * @returns {Promise<{ readonly allowed: boolean; readonly newLimitUsd?: number }>} Budget enforcement outcome.
 */
export async function evaluateLaneItemBudget<TIn = unknown>(
  cfg: LaneSchedulerConfig<TIn>,
  item: LaneQueuedItemState<TIn>,
  syncTracker: (itemKey: string, state: string) => Promise<void>,
): Promise<{ readonly allowed: boolean; readonly newLimitUsd?: number }> {
  const maxCfg = cfg.lane.maxCostUsd;
  const currentLimit = item.approvedMaxCostUsd ?? maxCfg?.limitUsd;
  if (maxCfg === undefined || currentLimit === undefined || item.costUsd <= currentLimit) {
    return Object.freeze({ allowed: true, newLimitUsd: currentLimit });
  }
  const adapter = cfg.humanAdaptersById?.get(maxCfg.approver.human.id);
  if (adapter === undefined) {
    throw new Error(`No HumanAdapter for budget approver '${maxCfg.approver.human.id}'.`);
  }
  const decision = BudgetApprovalSchema.parse(
    await adapter.requestDecision({
      requestId: `budget:${item.runId}:${String(item.costUsd)}`,
      runId: item.runId,
      humanId: maxCfg.approver.human.id,
      payload: { costUsd: item.costUsd, limitUsd: currentLimit },
      responseSchema: BudgetApprovalSchema,
      signal: item.activeFlowCtx?.activeStepAbortController.signal,
    }),
  );
  const nextLimit = decision.increaseLimitToUsd ?? currentLimit * 2;
  if (decision.approved && nextLimit > item.costUsd) {
    item.approvedMaxCostUsd = nextLimit;
    await cfg.ledgerStore.createOrResumeRun({
      runId: item.runId,
      laneId: item.laneId,
      itemKey: item.itemKey,
      inputJson: JSON.stringify(item.input),
      costUsd: item.costUsd,
      approvedMaxCostUsd: nextLimit,
    });
    return Object.freeze({ allowed: true, newLimitUsd: nextLimit });
  }
  item.status = 'CANCELLED';
  item.terminalExitState = 'cancelled';
  if (item.activeFlowCtx !== undefined) {
    await executeHierarchicalRewindDrain({
      flowCtx: item.activeFlowCtx,
      rewindToStepId: null,
      updatedInput: item.input,
      stepTerminalStatus: 'CANCELLED',
    });
  }
  await cfg.ledgerStore.recordRunTerminalReceipt(item.runId, item.itemKey, 'cancelled');
  await syncTracker(item.itemKey, 'cancelled');
  return Object.freeze({ allowed: false });
}
