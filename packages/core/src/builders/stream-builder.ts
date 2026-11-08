import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type { AstBuilder } from '../ast/ast-builder.js';
import type { StreamSourceASTNode } from '../ast/domain-ast.types.js';
import type { SignalNode } from '../ast/signal-node.js';
import type { StreamNode } from '../ast/stream-node.js';

/**
 * Fluent builder for inbound event streams (`P.stream(id)`).
 *
 * Connects an external `StreamSourceASTNode` through an optional synchronous filter
 * predicate to a typed `SignalNode` emission rule.
 *
 * @template TEvent   Inbound event payload type from the stream source.
 * @template TPayload Outbound signal payload type emitted into the harness.
 */
export interface StreamBuilder<TEvent = unknown, TPayload = unknown>
  extends AstBuilder<StreamNode<TEvent, TPayload>> {
  /** Unique identifier of the stream definition. */
  readonly id: string;

  /**
   * Binds the inbound `StreamSourceASTNode<TNextEvent>` for this stream.
   *
   * Resets any previously bound filter predicate when the inbound event type changes.
   *
   * @template TNextEvent Inbound event type produced by `streamSource`.
   *
   * @param {MaybeBuilder<StreamSourceASTNode<TNextEvent>>} streamSource - Stream source node or builder.
   *
   * @returns {StreamBuilder<TNextEvent, TPayload>} New immutable stream builder instance.
   */
  source<TNextEvent>(
    streamSource: MaybeBuilder<StreamSourceASTNode<TNextEvent>>,
  ): StreamBuilder<TNextEvent, TPayload>;

  /**
   * Binds a synchronous predicate filtering inbound events before signal projection.
   *
   * Events for which `predicate(event)` returns `false` are dropped before `emitSignal` runs.
   *
   * @param {(event: TEvent) => boolean} predicate - Synchronous event filter predicate.
   *
   * @returns {StreamBuilder<TEvent, TPayload>} New immutable stream builder instance.
   */
  filter(predicate: (event: TEvent) => boolean): StreamBuilder<TEvent, TPayload>;

  /**
   * Binds the target `SignalNode<TNextPayload>` and synchronous payload mapper emitted when an event matches.
   *
   * Every matching event is projected via `mapPayload(event)` and validated against `signal.schema`.
   *
   * @template TNextPayload Signal payload type.
   *
   * @param {MaybeBuilder<SignalNode<TNextPayload>>} signal     - Target signal node or builder.
   * @param {(event: TEvent) => TNextPayload}        mapPayload - Synchronous event-to-signal payload mapper.
   *
   * @returns {StreamBuilder<TEvent, TNextPayload>} New immutable stream builder instance.
   */
  emitSignal<TNextPayload>(
    signal: MaybeBuilder<SignalNode<TNextPayload>>,
    mapPayload: (event: TEvent) => TNextPayload,
  ): StreamBuilder<TEvent, TNextPayload>;
}
