import type { AdjudicateInterruptHandlerNode } from './adjudicate-interrupt-handler-node.js';
import type { AskInterruptHandlerNode } from './ask-interrupt-handler-node.js';
import type { ReplaceInterruptHandlerNode } from './replace-interrupt-handler-node.js';

export type {
  AdjudicateInterruptHandlerNode,
  AdjudicateLeaseElevationConfig,
} from './adjudicate-interrupt-handler-node.js';
export type {
  AskInterruptHandlerNode,
  AskLeaseElevationConfig,
} from './ask-interrupt-handler-node.js';
export type { ReplaceInterruptHandlerNode } from './replace-interrupt-handler-node.js';

/**
 * Passive AST node representing an actor-level or step-level `.onInterrupt(interrupt, $intr => ...)` edge.
 *
 * @template TIn      Flow or actor input payload type.
 * @template TPayload Interrupt payload type.
 * @template THandle  Runtime handle type of the active isolation scope.
 */
export type InterruptHandlerNode<TIn = unknown, TPayload = unknown, THandle = unknown> =
  | AdjudicateInterruptHandlerNode<TIn, TPayload, THandle>
  | AskInterruptHandlerNode<TPayload>
  | ReplaceInterruptHandlerNode<TIn, TPayload, THandle>;
