import type { DenyWithErrorPolicyGuardClauseNode } from './deny-with-error-policy-guard-clause-node.js';
import type { RaiseInterruptPolicyGuardClauseNode } from './raise-interrupt-policy-guard-clause-node.js';

export type { DenyWithErrorPolicyGuardClauseNode } from './deny-with-error-policy-guard-clause-node.js';
export type { RaiseInterruptPolicyGuardClauseNode } from './raise-interrupt-policy-guard-clause-node.js';

/**
 * Passive AST node representing a single `.guard(...).onViolation(...)` clause inside a `PolicyNode`.
 */
export type PolicyGuardClauseNode =
  | DenyWithErrorPolicyGuardClauseNode
  | RaiseInterruptPolicyGuardClauseNode;
