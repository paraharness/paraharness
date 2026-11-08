import type { BivariantCallback } from './ast-foundation.types.js';
import type { StreamSourceASTNode } from './domain-ast.types.js';
import type { SignalNode } from './signal-node.js';

/**
 * Passive AST node representing an inbound event stream (`M.stream(id)`).
 *
 * Subscribes to a `StreamSourceASTNode<TEvent>`, optionally filters inbound events via `filterFn`,
 * and projects matching events into a typed `SignalNode<TPayload>` via `mapPayload`.
 *
 * @template TEvent   Inbound raw event type emitted by `source`.
 * @template TPayload Outbound signal payload type emitted into the harness.
 */
export interface StreamNode<TEvent = unknown, TPayload = unknown> {
  /** Discriminant identifying an inbound stream AST node. */
  readonly type: 'harness:stream';
  /** Unique identifier of the stream definition. */
  readonly id: string;
  /** Passive stream source AST node providing inbound events. */
  readonly source: StreamSourceASTNode<TEvent>;
  /** Optional synchronous predicate filtering raw events before signal emission. */
  readonly filterFn?: BivariantCallback<[event: TEvent], boolean>;
  /** Target `SignalNode<TPayload>` emitted when an event matches. */
  readonly signal: SignalNode<TPayload>;
  /** Synchronous mapper projecting a matched `TEvent` into `TPayload`. */
  readonly mapPayload: BivariantCallback<[event: TEvent], TPayload>;
}
