import { z } from '@metaharness/core';
import type { NetSuiteRollbackAbortHookNode } from '../nodes/netsuite-rollback-abort-hook-node.js';
import '../nodes/netsuite-registry-augmentation.js';

/**
 * Compiles a passive `NetSuiteRollbackAbortHookNode` (`netsuite.rollbackDraftJournal`).
 *
 * Emits a frozen abort hook AST node that clears uncommitted staged lines and marks the
 * active `NetSuiteDraftHandle` as `'rolled-back'` during `.replaceWith()` or `.onLimitExceeded()` transitions.
 *
 * @param {string} [id='netsuite:rollback-draft-journal'] - Optional abort hook node identifier.
 *
 * @returns {NetSuiteRollbackAbortHookNode} Frozen passive NetSuite draft journal rollback abort hook AST node.
 */
export function createNetSuiteRollbackAbortHookBuilder(
  id = 'netsuite:rollback-draft-journal',
): NetSuiteRollbackAbortHookNode {
  return Object.freeze<NetSuiteRollbackAbortHookNode>({
    type: 'netsuite:rollback-abort-hook',
    id,
    metaSchema: z.object({}).passthrough(),
  });
}
