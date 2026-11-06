import type { PolicyGuardASTNode } from './domain-ast.types.js';
import type { InterruptNode } from './interrupt-node.js';
import type { PolicyViolation } from './policy-violation.js';

/**
 * Guard clause node that blocks unauthorized tool calls in-band with an `isError: true` tool result.
 */
export type DenyWithErrorPolicyGuardClauseNode = {
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
};

/**
 * Guard clause node that intercepts unauthorized tool calls and raises a structured `InterruptNode`.
 *
 * @template TPayload Interrupt payload type produced by `mapViolation`.
 */
export type RaiseInterruptPolicyGuardClauseNode<TPayload = unknown> = {
  /** Discriminant identifying a policy guard clause AST node. */
  readonly type: 'harness:policy-guard-clause';
  /** Deterministic clause identifier (`"${policyId}:clause:${index}"`). */
  readonly id: string;
  /** Guard AST nodes evaluated by this clause. */
  readonly guards: readonly PolicyGuardASTNode[];
  /** Interrupt-raising violation mode. */
  readonly mode: 'raise-interrupt';
  /** Target `InterruptNode` raised when this clause is violated. */
  readonly interrupt: InterruptNode<TPayload>;
  /** Pure synchronous mapper projecting a `PolicyViolation` into `interrupt.schema`. */
  readonly mapViolation: (violation: PolicyViolation) => TPayload;
};

/**
 * Passive AST node representing a single `.guard(...).onViolation(...)` clause inside a `PolicyNode`.
 */
export type PolicyGuardClauseNode =
  | DenyWithErrorPolicyGuardClauseNode
  | RaiseInterruptPolicyGuardClauseNode;
