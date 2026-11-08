import { z } from '@metaharness/core';
import type { NetSuiteJournalToolNode } from '../nodes/netsuite-journal-tool-node.js';
import '../nodes/netsuite-registry-augmentation.js';

/**
 * Creates the passive `NetSuiteJournalToolNode` bundle for staging and committing draft journal lines (`netsuite.journalTools`).
 *
 * Emits frozen `NetSuiteJournalToolNode` descriptors with `effectTracking: 'declared'` so
 * `NetSuiteClosedPeriodGuardNode` evaluates pre-flight `netsuite:journal-effect` descriptors.
 *
 * @returns {readonly NetSuiteJournalToolNode[]} Frozen tuple of NetSuite draft journal tool AST nodes.
 */
export function createNetSuiteJournalTools(): readonly NetSuiteJournalToolNode[] {
  const addLineTool = Object.freeze<NetSuiteJournalToolNode>({
    type: 'netsuite:journal-tool',
    name: 'netsuite_add_journal_line',
    description: 'Stages a debit or credit line inside the active NetSuite draft journal scope.',
    inputSchema: z.object({
      accountId: z.string(),
      debitUsd: z.number(),
      creditUsd: z.number(),
      postingPeriod: z.string(),
      periodClosed: z.boolean().optional(),
    }),
    effectTracking: 'declared',
  });

  const commitJournalTool = Object.freeze<NetSuiteJournalToolNode>({
    type: 'netsuite:journal-tool',
    name: 'netsuite_commit_journal',
    description: 'Marks the balanced NetSuite draft journal ready for final settlement posting.',
    inputSchema: z.object({
      memo: z.string().optional(),
    }),
    effectTracking: 'declared',
  });

  return Object.freeze([addLineTool, commitJournalTool]);
}
