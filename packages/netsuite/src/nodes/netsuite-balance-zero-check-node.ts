import type { BaseCheckASTNode } from '@paraharness/core';
import type { NetSuiteDraftHandle } from './netsuite-draft-handle.js';

/**
 * Passive deterministic check AST node verifying that a NetSuite draft journal balances to zero (`netsuite.balanceZeroCheck`).
 *
 * Executed at actor `.beforeStop()` gates to ensure total debits equal total credits
 * before a financial reconciliation agent can complete.
 *
 * @template THandle Isolation scope handle type (defaults to `NetSuiteDraftHandle`).
 */
export interface NetSuiteBalanceZeroCheckNode<THandle = NetSuiteDraftHandle>
  extends BaseCheckASTNode<'netsuite:balance-zero-check', THandle> {
  /** Discriminant identifying a NetSuite zero-balance check AST node. */
  readonly type: 'netsuite:balance-zero-check';
}
