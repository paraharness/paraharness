import { z } from '@harness-dsl/core';
import type { DraftJournalReceipt } from '../nodes/draft-journal-receipt.js';
import type { NetSuiteDraftScopeNode } from '../nodes/netsuite-draft-scope-node.js';
import '../nodes/netsuite-registry-augmentation.js';

/**
 * Compiles a passive `NetSuiteDraftScopeNode` (`netsuite.draftJournalScope`).
 *
 * Emits a frozen Tier-1 isolation scope AST node (`capabilityTier: 'scope'`,
 * `supportsCheckpoints: false`, `supportsBranching: false`) with a `DraftJournalReceipt` Zod schema.
 *
 * @param {string} [id='netsuite:draft-journal-scope'] - Optional scope identifier.
 *
 * @returns {NetSuiteDraftScopeNode} Frozen passive NetSuite draft journal scope AST node.
 */
export function createNetSuiteDraftJournalScopeBuilder(
  id = 'netsuite:draft-journal-scope',
): NetSuiteDraftScopeNode {
  const receiptSchema: z.ZodType<DraftJournalReceipt> = z
    .object({
      journalId: z.string(),
      runId: z.string(),
      status: z.enum(['open', 'rolled-back', 'committed', 'released']),
      totalDebitUsd: z.number(),
      totalCreditUsd: z.number(),
      netBalanceUsd: z.number(),
      lineCount: z.number(),
    })
    .passthrough();

  return Object.freeze<NetSuiteDraftScopeNode>({
    type: 'netsuite:draft-scope',
    id,
    capabilityTier: 'scope',
    supportsCheckpoints: false,
    supportsBranching: false,
    receiptSchema,
  });
}
