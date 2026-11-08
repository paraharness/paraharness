import type { NetSuiteBalanceZeroCheckNode } from '../nodes/netsuite-balance-zero-check-node.js';
import '../nodes/netsuite-registry-augmentation.js';

/**
 * Compiles a passive `NetSuiteBalanceZeroCheckNode` (`netsuite.balanceZeroCheck`).
 *
 * Emits a frozen deterministic check AST node verifying that total debits equal total credits
 * in the active `NetSuiteDraftHandle` before an actor completes.
 *
 * @param {string} [id='netsuite:balance-zero-check'] - Optional check node identifier.
 *
 * @returns {NetSuiteBalanceZeroCheckNode} Frozen passive NetSuite zero-balance check AST node.
 */
export function createNetSuiteBalanceZeroCheckBuilder(
  id = 'netsuite:balance-zero-check',
): NetSuiteBalanceZeroCheckNode {
  return Object.freeze<NetSuiteBalanceZeroCheckNode>({
    type: 'netsuite:balance-zero-check',
    id,
  });
}
