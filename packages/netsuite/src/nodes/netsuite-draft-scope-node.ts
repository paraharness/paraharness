import type { BaseIsolationScopeASTNode } from '@metaharness/core';
import type { DraftJournalReceipt } from './draft-journal-receipt.js';
import type { NetSuiteDraftHandle } from './netsuite-draft-handle.js';

/**
 * Passive Tier-1 isolation scope AST node for NetSuite draft journals (`netsuite.draftJournalScope`).
 *
 * Declares `capabilityTier: 'scope'`, `supportsCheckpoints: false`, and `supportsBranching: false`
 * so financial reconciliation workflows run over `IsolationScope<NetSuiteDraftHandle, DraftJournalReceipt>`
 * without requiring git worktree branching semantics.
 */
export interface NetSuiteDraftScopeNode
  extends BaseIsolationScopeASTNode<
    'netsuite:draft-scope',
    NetSuiteDraftHandle,
    DraftJournalReceipt,
    Record<string, unknown>,
    'scope'
  > {
  /** Discriminant identifying a NetSuite draft journal isolation scope AST node. */
  readonly type: 'netsuite:draft-scope';
  /** Declarative Tier-1 capability tier (`'scope'`). */
  readonly capabilityTier: 'scope';
  /** Static indicator that Tier-2 checkpointing is not supported. */
  readonly supportsCheckpoints: false;
  /** Static indicator that Tier-3 branching is not supported. */
  readonly supportsBranching: false;
}
