/**
 * Domain-agnostic base AST node contract for asynchronous event stream sources (`StreamSourceASTNode`).
 *
 * Resolved via `RuntimeExecutorRegistry.streamSources[node.type]` into a `StreamSource`
 * subscribed to by `M.stream()`.
 *
 * @template TType  String-literal discriminant of the stream source node.
 * @template TEvent Raw event payload type emitted by the stream source.
 */
export interface BaseStreamSourceASTNode<TType extends string = string, TEvent = unknown> {
  /** Unique string-literal discriminant of the stream source node. */
  readonly type: TType;
  /** Phantom type brand preserving the stream event payload type. */
  readonly __eventBrand?: TEvent;
}
