import type { BivariantCallback } from './ast-foundation.types.js';
import type { InterruptNode } from './interrupt-node.js';

/**
 * Passive AST node representing an upward child-interrupt handler declared on a parent agent (`.onChildInterrupt(interrupt, $intr => ...)`).
 *
 * Instructs the runtime to suspend the raising child fork at its continuation stack, pause concurrent
 * sibling forks in `pauseSiblingForksInPartitions(payload)`, and return a normal `tool_result` to the parent timeline.
 *
 * @template TPayload Interrupt payload type validated by `interrupt.schema`.
 */
export interface ChildInterruptHandlerNode<TPayload = unknown> {
  /** Discriminant identifying a child interrupt handler AST node. */
  readonly type: 'harness:child-interrupt-handler';
  /** Upward `InterruptNode` intercepted from a downward child fork or speculative branch. */
  readonly interrupt: InterruptNode<TPayload>;
  /** Optional synchronous mapper returning partition IDs whose concurrent sibling forks must pause at the turn-batch barrier. */
  readonly pauseSiblingForksInPartitions?: BivariantCallback<
    [payload: TPayload],
    readonly string[]
  >;
  /** Continuation-stack suspension mode returning control to the parent actor's single timeline. */
  readonly mode: 'suspend-and-return-to-parent';
}
