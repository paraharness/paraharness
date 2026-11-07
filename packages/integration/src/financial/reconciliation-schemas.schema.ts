import { z } from '@harness-dsl/core';

/**
 * Zod schema validating a regional ledger discrepancy work item (`SPEC.md` §5).
 *
 * Specifies the `discrepancyId`, `accountRegion` (`'us-east'` or `'eu-west'`), and `varianceUsd`.
 */
export const discrepancyItem = z.object({
  discrepancyId: z.string(),
  accountRegion: z.enum(['us-east', 'eu-west']),
  varianceUsd: z.number(),
});

/** Validated regional ledger discrepancy payload inferred from `discrepancyItem`. */
export type DiscrepancyItem = z.infer<typeof discrepancyItem>;

/**
 * Zod schema validating a completed NetSuite and Stripe reconciliation receipt (`SPEC.md` §5).
 *
 * Records the finalized `journalEntryId` and the `reconciledAmountUsd`.
 */
export const settlementReceipt = z.object({
  journalEntryId: z.string(),
  reconciledAmountUsd: z.number(),
});

/** Validated financial settlement receipt payload inferred from `settlementReceipt`. */
export type SettlementReceipt = z.infer<typeof settlementReceipt>;
