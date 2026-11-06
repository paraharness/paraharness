import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import { extractAST } from '../ast/extract-ast.js';
import type { InterruptNode } from '../ast/interrupt-node.js';
import type { EscalateCapabilityBuilder } from './escalate-capability-builder.js';
import { createEscalateFromState } from './internal/create-escalate-from-state.js';

/**
 * Creates a fluent `EscalateCapabilityBuilder` for `cap.escalate(interrupt, $esc => ...)`.
 *
 * Extracts the target `InterruptNode` and requires both `.to(human)` and `.response(schema)`
 * to be configured before `.toAST()` compilation.
 *
 * @template TPayload Validated interrupt payload type.
 *
 * @param {MaybeBuilder<InterruptNode<TPayload>>} interrupt - Interrupt definition raised by the escalation tool.
 *
 * @returns {EscalateCapabilityBuilder<TPayload, unknown>} Frozen `EscalateCapabilityBuilder` instance.
 */
export function createEscalateCapabilityBuilder<TPayload = unknown>(
  interrupt: MaybeBuilder<InterruptNode<TPayload>>,
): EscalateCapabilityBuilder<TPayload, unknown> {
  return createEscalateFromState({
    interrupt: extractAST(interrupt),
    human: undefined,
    responseSchema: undefined,
    elevateLeaseWhen: undefined,
  });
}
