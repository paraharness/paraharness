import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import { extractAST } from '../ast/extract-ast.js';
import type { InterruptNode } from '../ast/interrupt-node.js';
import { createInterruptEdgeFromState } from './internal/interrupt-edge-sub-builders.js';
import type { InterruptEdgeBuilder } from './interrupt-edge-builder.js';

/**
 * Creates a fluent `InterruptEdgeBuilder` for `.onInterrupt(interrupt, $i => ...)`.
 *
 * Extracts the target `InterruptNode` and returns an immutable builder supporting
 * `.adjudicateWith()`, `.ask()`, and `.onAbort().replaceWith()` resolution strategies.
 *
 * @template TIn            Enclosing step input payload type.
 * @template TPayload       Validated interrupt payload type.
 * @template THandle        Isolation scope handle type.
 * @template TCustomMetrics Custom step telemetry metrics type.
 * @template TAbortMeta     Abort hook metadata type.
 *
 * @param {MaybeBuilder<InterruptNode<TPayload>>} interrupt - Target interrupt AST node or builder.
 *
 * @returns {InterruptEdgeBuilder<TIn, TPayload, THandle, TCustomMetrics, TAbortMeta>} Frozen interrupt edge builder.
 */
export function createInterruptEdgeBuilder<
  TIn = unknown,
  TPayload = unknown,
  THandle = unknown,
  TCustomMetrics extends Record<string, unknown> = Record<string, unknown>,
  TAbortMeta extends Record<string, unknown> = Record<string, unknown>,
>(
  interrupt: MaybeBuilder<InterruptNode<TPayload>>,
): InterruptEdgeBuilder<TIn, TPayload, THandle, TCustomMetrics, TAbortMeta> {
  return createInterruptEdgeFromState({
    interrupt: extractAST(interrupt),
    abortHook: undefined,
  });
}
