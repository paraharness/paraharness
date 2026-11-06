import type { AstBuilder } from '../ast/ast-builder.js';
import type { ReplaceInterruptHandlerNode } from '../ast/interrupt-handler-node.types.js';

/**
 * Compiled builder returned by `InterruptEdgeBuilder.replaceWith(replacementExecutable, mapReplacementInput)`.
 *
 * Wraps the deeply frozen `ReplaceInterruptHandlerNode` so it can be returned from
 * `.onInterrupt(interrupt, $intr => $intr.replaceWith(...))` callbacks.
 *
 * @template TIn      Flow or actor input payload type.
 * @template TPayload Interrupt payload type.
 * @template THandle  Runtime handle type of the active isolation scope.
 */
export interface ReplaceInterruptBuilder<
  TIn = unknown,
  TPayload = unknown,
  THandle = unknown,
> extends AstBuilder<ReplaceInterruptHandlerNode<TIn, TPayload, THandle>> {
  /**
   * Compiles and returns the deeply frozen `ReplaceInterruptHandlerNode`.
   *
   * Preserves the bound abort hook, replacement executable, and replacement input mapper.
   *
   * @returns {ReplaceInterruptHandlerNode<TIn, TPayload, THandle>} Frozen replace interrupt handler node.
   */
  toAST(): ReplaceInterruptHandlerNode<TIn, TPayload, THandle>;
}
