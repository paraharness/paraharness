import { M, z } from '@metaharness/core';
import { netsuite } from '@metaharness/netsuite';
import { slack } from '@metaharness/slack';
import { stripe } from '@metaharness/stripe';
import { opus } from '../engineering/pools-and-services.constants.js';
import './financial-domain-registry.js';
import {
  discrepancyItem,
  settlementReceipt,
} from './reconciliation-schemas.schema.js';

/**
 * Pre-flight policy interrupt (`high-value-approval`) raised when a Stripe refund exceeds $500 (`SPEC.md` §5).
 *
 * Carries the `proposedJournalId`, `amountUsd`, and `reason` while holding the NetSuite draft journal open
 * in `PendingToolBatch` until `financeController` adjudicates.
 */
export const highValueApprovalRequest = M.interrupt('high-value-approval').payload(
  z.object({ proposedJournalId: z.string(), amountUsd: z.number(), reason: z.string() }),
);

/**
 * Turn-limit exhaustion interrupt (`reconcile-limit-exceeded`) flushed when `reconciliationAgent` exceeds 6 turns (`SPEC.md` §5).
 *
 * Triggers `netsuite.rollbackDraftJournal()` and replaces `reconciliationAgent` with `manualEscalationAgent`.
 */
export const reconcileLimitExceeded = M.interrupt('reconcile-limit-exceeded').payload(
  z.object({ summary: z.string() }),
);

/**
 * Human finance controller escalation target (`finance-controller`) notified via Slack (`SPEC.md` §5).
 *
 * Adjudicates `highValueApprovalRequest` interrupts and optionally elevates the refund lease up to $10,000.
 */
export const financeController = M.human('finance-controller')
  .keepAliveSeconds(60)
  .notify(
    slack.bot({
      appToken: M.env('FINANCE_SLACK_APP_TOKEN'),
      botToken: M.env('FINANCE_SLACK_BOT_TOKEN'),
      channel: M.env('FINANCE_SLACK_CHANNEL_ID'),
    }),
  );

/**
 * Automated reconciliation policy (`auto-reconcile-bounds`) with chained NetSuite and Stripe guards (`SPEC.md` §5).
 *
 * Clause 1 unconditionally denies closed-period NetSuite postings in-band; Clause 2 raises `highValueApprovalRequest`
 * on Stripe refunds exceeding $500; turn exhaustion (6 turns) flushes `reconcileLimitExceeded` and rolls back the draft journal.
 */
export const autoReconcilePolicy = M.policy('auto-reconcile-bounds')
  .guard(netsuite.forbidClosedPeriodPosting())
  .onViolation('deny-with-error')
  .guard(stripe.maxRefundGuardUsd(500))
  .onViolation('raise-interrupt', highValueApprovalRequest, (violation) => ({
    proposedJournalId: String(violation.violatedEffects[0]?.attributes?.['journalId'] ?? 'draft'),
    amountUsd: Number(violation.violatedEffects[0]?.attributes?.['amountUsd'] ?? 0),
    reason: violation.violationSummary,
  }))
  .maxTurns(6)
  .onAbort(netsuite.rollbackDraftJournal())
  .onLimitExceeded(($l) =>
    $l.flushWithInterrupt(reconcileLimitExceeded).onAbort(netsuite.rollbackDraftJournal()),
  );

/**
 * Manual escalation reconciliation policy (`manual-reconcile-bounds`) with a 15-turn ceiling (`SPEC.md` §5).
 *
 * Enforces `netsuite.forbidClosedPeriodPosting()` and rolls back the draft journal on abort without the $500 automated refund cap.
 */
export const manualReconcilePolicy = M.policy('manual-reconcile-bounds')
  .guard(netsuite.forbidClosedPeriodPosting())
  .onViolation('deny-with-error')
  .maxTurns(15)
  .onAbort(netsuite.rollbackDraftJournal());

/**
 * Primary automated financial reconciliation agent (`reconciler`) operating under `autoReconcilePolicy` (`SPEC.md` §5).
 *
 * Uses `stripe.readTools()` and `netsuite.journalTools()` and verifies zero journal balance via `netsuite.balanceZeroCheck()` before stopping.
 */
export const reconciliationAgent = M.agent('reconciler')
  .model(opus)
  .policy(autoReconcilePolicy)
  .tools(stripe.readTools(), netsuite.journalTools())
  .instructions('Reconcile the regional ledger variance against Stripe settlement records.')
  .beforeStop(netsuite.balanceZeroCheck())
  .input(discrepancyItem)
  .partitions((item) => [item.accountRegion])
  .output(settlementReceipt);

/**
 * Replacement reconciliation agent (`manual-reconcile-escalator`) invoked after `reconcileLimitExceeded` (`SPEC.md` §5).
 *
 * Receives the original `discrepancyItem` extended with `priorFailureSummary` and completes reconciliation under `manualReconcilePolicy`.
 */
export const manualEscalationAgent = M.agent('manual-reconcile-escalator')
  .model(opus)
  .policy(manualReconcilePolicy)
  .tools(stripe.readTools(), netsuite.journalTools())
  .instructions('Complete the escalated reconciliation using the prior failure summary and controller guidance.')
  .beforeStop(netsuite.balanceZeroCheck())
  .input(discrepancyItem.extend({ priorFailureSummary: z.string() }))
  .partitions((item) => [item.accountRegion])
  .output(settlementReceipt);

/**
 * Non-coding financial reconciliation flow (`reconcile-discrepancy`) over Tier-1 `netsuite.draftJournalScope()` (`SPEC.md` §5).
 *
 * Executes `reconciliationAgent`, adjudicates `highValueApprovalRequest` with `financeController` (elevating the refund lease
 * to `stripe.allowRefundUpToUsd(10_000)` when approved), and replaces with `manualEscalationAgent` on `reconcileLimitExceeded`.
 */
export const reconciliationFlow = M.flow('reconcile-discrepancy')
  .input(discrepancyItem)
  .scope(netsuite.draftJournalScope())
  .step('attempt-reconcile', reconciliationAgent, ($s) =>
    $s
      .onInterrupt(highValueApprovalRequest, ($intr) =>
        $intr
          .ask(financeController, z.object({ approved: z.boolean(), note: z.string() }))
          .elevateLeaseWhen((decision) => decision.approved, () => stripe.allowRefundUpToUsd(10_000))
          .resumeWith((decision) => `Controller decision: ${decision.approved ? 'Approved' : 'Denied'} (${decision.note})`),
      )
      .onInterrupt(reconcileLimitExceeded, ($limit) =>
        $limit
          .onAbort(netsuite.rollbackDraftJournal())
          .replaceWith(manualEscalationAgent, (item, payload) => ({
            discrepancyId: item.discrepancyId,
            accountRegion: item.accountRegion,
            varianceUsd: item.varianceUsd,
            priorFailureSummary: payload.summary,
          })),
      ),
  )
  .exit('done');
