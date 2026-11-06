import type { ASTNode } from './ast-node.js';
import type { PolicyGuardASTNode } from './domain-ast.types.js';
import type { PolicyViolation } from './policy-violation.js';

/**
 * Guard clause node that blocks unauthorized tool calls in-band with an `isError: true` tool result.
 *
 * Formats the blocked `PolicyViolation` via `messageMapper` (or a default diagnostic message) without halting the turn loop.
 */
export interface DenyWithErrorPolicyGuardClauseNode extends ASTNode {
  /** Discriminant identifying a policy guard clause AST node. */
  readonly type: 'harness:policy-guard-clause';
  /** Deterministic clause identifier (`"${policyId}:clause:${index}"`). */
  readonly id: string;
  /** Guard AST nodes evaluated by this clause. */
  readonly guards: readonly PolicyGuardASTNode[];
  /** In-band error denial mode. */
  readonly mode: 'deny-with-error';
  /** Optional custom formatter producing the in-band error message returned to the model. */
  readonly messageMapper?: (violation: PolicyViolation) => string;
}
