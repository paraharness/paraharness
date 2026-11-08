import type { NetSuiteClosedPeriodGuardNode } from '../nodes/netsuite-closed-period-guard-node.js';
import '../nodes/netsuite-registry-augmentation.js';

/**
 * Compiles a passive `NetSuiteClosedPeriodGuardNode` (`netsuite.forbidClosedPeriodPosting`).
 *
 * Emits a frozen policy guard AST node that denies journal line postings targeting closed accounting periods.
 *
 * @param {string} [id='netsuite:forbid-closed-period-posting'] - Optional policy guard identifier.
 *
 * @returns {NetSuiteClosedPeriodGuardNode} Frozen passive NetSuite closed-period policy guard AST node.
 */
export function createNetSuiteClosedPeriodGuardBuilder(
  id = 'netsuite:forbid-closed-period-posting',
): NetSuiteClosedPeriodGuardNode {
  return Object.freeze<NetSuiteClosedPeriodGuardNode>({
    type: 'netsuite:closed-period-guard',
    id,
  });
}
