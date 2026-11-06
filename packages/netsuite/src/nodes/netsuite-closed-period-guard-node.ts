import type { BasePolicyGuardASTNode } from '@harness-dsl/core';

/**
 * Passive policy guard AST node forbidding journal postings into closed accounting periods (`netsuite.forbidClosedPeriodPosting`).
 *
 * Evaluates pre-flight `netsuite:journal-effect` descriptors and unconditionally denies
 * tool calls whose target accounting period is closed (`periodClosed: true`).
 */
export interface NetSuiteClosedPeriodGuardNode
  extends BasePolicyGuardASTNode<'netsuite:closed-period-guard'> {
  /** Discriminant identifying a NetSuite closed-period policy guard AST node. */
  readonly type: 'netsuite:closed-period-guard';
}
