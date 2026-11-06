import type { BaseAbortHookASTNode } from '@harness-dsl/core';
import type { NetSuiteDraftHandle } from './netsuite-draft-handle.js';

/**
 * Passive abort hook AST node rolling back uncommitted NetSuite draft journal entries (`netsuite.rollbackDraftJournal`).
 *
 * Satisfies the Tier-1 `'scope'` abort-hook requirement when an interrupted financial
 * reconciliation step transitions via `.replaceWith(...)` or `.onLimitExceeded(...)`.
 *
 * @template THandle Isolation scope handle type (defaults to `NetSuiteDraftHandle`).
 */
export interface NetSuiteRollbackAbortHookNode<THandle = NetSuiteDraftHandle>
  extends BaseAbortHookASTNode<
    'netsuite:rollback-abort-hook',
    THandle,
    Record<string, unknown>
  > {
  /** Discriminant identifying a NetSuite draft journal rollback abort hook AST node. */
  readonly type: 'netsuite:rollback-abort-hook';
}
