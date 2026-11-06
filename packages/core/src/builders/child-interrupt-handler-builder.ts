import type { AstBuilder } from '../ast/ast-builder.js';
import type { ChildInterruptHandlerNode } from '../ast/child-interrupt-handler-node.js';

/**
 * Fluent builder for upward child-interrupt handlers declared on a parent agent (`.onChildInterrupt(interrupt, $intr => ...)`).
 *
 * Configures optional partition-scoped sibling fork pausing and suspends the raising child
 * fork's continuation stack to return a `SUSPENDED_ON_INTERRUPT` result to the parent agent.
 *
 * @template TPayload Interrupt payload type validated by `interrupt.schema`.
 */
export interface ChildInterruptHandlerBuilder<TPayload = unknown>
  extends AstBuilder<ChildInterruptHandlerNode<TPayload>> {
  /**
   * Specifies a synchronous mapper returning partition IDs whose concurrent sibling forks must pause at the turn-batch barrier.
   *
   * Prevents sibling forks in affected partitions from continuing over stale assumptions while the parent resolves the interrupt.
   *
   * @param {(payload: TPayload) => readonly string[]} mapper - Partition ID extractor from the interrupt payload.
   *
   * @returns {ChildInterruptHandlerBuilder<TPayload>} New immutable child interrupt builder.
   */
  pauseSiblingForksInPartitions(
    mapper: (payload: TPayload) => readonly string[],
  ): ChildInterruptHandlerBuilder<TPayload>;

  /**
   * Suspends the raising child fork's continuation stack and returns a `SUSPENDED_ON_INTERRUPT` `tool_result` to the parent timeline.
   *
   * Allows the parent agent to inspect the interrupt payload and resume the suspended fork via `resumeFork`.
   *
   * @returns {ChildInterruptHandlerBuilder<TPayload>} New immutable child interrupt builder.
   */
  suspendAndReturnToParent(): ChildInterruptHandlerBuilder<TPayload>;
}
