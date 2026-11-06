import type { ASTNode } from './ast-node.js';
import type { PolicyGuardASTNode } from './domain-ast.types.js';
import type { InterruptNode } from './interrupt-node.js';
import type { PolicyViolation } from './policy-violation.js';

/**
 * Guard clause node that intercepts unauthorized tool calls and raises a structured `InterruptNode`.
 *
 * Maps the `PolicyViolation` into `interrupt.schema` via `mapViolation` and suspends the tool batch for adjudication.
 *
 * @template TPayload Interrupt payload type produced by `mapViolation`.
 */
export interface RaiseInterruptPolicyGuardClauseNode<TPayload = unknown> extends ASTNode {
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
}
