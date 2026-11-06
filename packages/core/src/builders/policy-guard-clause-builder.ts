import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type { InterruptNode } from '../ast/interrupt-node.js';
import type { PolicyViolation } from '../ast/policy-violation.js';
import type { PolicyBuilder } from './policy-builder.js';

/**
 * Intermediate fluent builder returned by `H.policy(id).guard(...guards)` requiring `.onViolation(...)`.
 *
 * Completes a policy guard clause by specifying either `'deny-with-error'` in-band
 * rejection or `'raise-interrupt'` structured interrupt escalation.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface PolicyGuardClauseBuilder<THandle = unknown> {
  /**
   * Configures the guard clause to deny unauthorized tool calls in-band with an `isError: true` tool result.
   *
   * Appends a `DenyWithErrorPolicyGuardClauseNode` to the owning `PolicyBuilder`.
   *
   * @param {'deny-with-error'}                        mode            - In-band error denial mode.
   * @param {(violation: PolicyViolation) => string}   [messageMapper] - Optional custom error message formatter.
   *
   * @returns {PolicyBuilder<THandle>} New immutable policy builder with the clause appended.
   */
  onViolation(
    mode: 'deny-with-error',
    messageMapper?: (violation: PolicyViolation) => string,
  ): PolicyBuilder<THandle>;

  /**
   * Configures the guard clause to intercept unauthorized tool calls and raise a structured `InterruptNode`.
   *
   * Appends a `RaiseInterruptPolicyGuardClauseNode<TPayload>` to the owning `PolicyBuilder`.
   *
   * @template TPayload Interrupt payload type validated by `interrupt.schema`.
   *
   * @param {'raise-interrupt'}                        mode         - Interrupt-raising violation mode.
   * @param {MaybeBuilder<InterruptNode<TPayload>>}    interrupt    - Target interrupt node or builder.
   * @param {(violation: PolicyViolation) => TPayload} mapViolation - Synchronous violation-to-payload mapper.
   *
   * @returns {PolicyBuilder<THandle>} New immutable policy builder with the clause appended.
   */
  onViolation<TPayload>(
    mode: 'raise-interrupt',
    interrupt: MaybeBuilder<InterruptNode<TPayload>>,
    mapViolation: (violation: PolicyViolation) => TPayload,
  ): PolicyBuilder<THandle>;
}
