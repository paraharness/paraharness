import type { StreamSourceASTNode } from '../ast/domain-ast.types.js';
import type { SignalNode } from '../ast/signal-node.js';

/**
 * Optional copy-on-write state for `createStreamBuilder`.
 *
 * Captures the bound stream source, optional event filter predicate, target signal node,
 * and event-to-signal payload mapper.
 *
 * @template TEvent   Inbound event type.
 * @template TPayload Outbound signal payload type.
 */
export interface CreateStreamBuilderState<TEvent = unknown, TPayload = unknown> {
  /** Bound stream source AST node. */
  readonly source?: StreamSourceASTNode<TEvent>;
  /** Optional synchronous filter predicate. */
  readonly filterFn?: (event: TEvent) => boolean;
  /** Target signal AST node. */
  readonly signal?: SignalNode<TPayload>;
  /** Synchronous event-to-signal payload mapper. */
  readonly mapPayload?: (event: TEvent) => TPayload;
}
