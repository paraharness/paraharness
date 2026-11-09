import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import { extractAST } from '../ast/extract-ast.js';
import type { InterruptNode } from '../ast/interrupt-node.js';
import type { ChildInterruptHandlerBuilder } from './child-interrupt-handler-builder.js';
import { createChildInterruptFromState } from './internal/create-ask-and-child-interrupt-from-state.js';

/**
 * Creates a fluent `ChildInterruptHandlerBuilder` for `agent.onChildInterrupt(interrupt, $ci => ...)`.
 *
 * Extracts the target `InterruptNode` and initializes an immutable child interrupt
 * handler builder with no partition sibling pauses configured.
 *
 * @template TPayload Validated interrupt payload type raised by the forked child.
 *
 * @param {MaybeBuilder<InterruptNode<TPayload>>} interrupt - Interrupt definition caught from forked children.
 *
 * @returns {ChildInterruptHandlerBuilder<TPayload>} Frozen child interrupt handler builder.
 */
export function createChildInterruptHandlerBuilder<TPayload = unknown>(
  interrupt: MaybeBuilder<InterruptNode<TPayload>>,
): ChildInterruptHandlerBuilder<TPayload> {
  return createChildInterruptFromState({
    interrupt: extractAST(interrupt),
    pauseSiblingForksInPartitions: undefined,
    suspended: true,
  });
}
