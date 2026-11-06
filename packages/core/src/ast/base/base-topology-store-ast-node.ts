/**
 * Domain-agnostic base AST node contract for relational partition topology stores (`TopologyStoreASTNode`).
 *
 * Resolved against the host process root via `RuntimeExecutorRegistry.topologies[node.type]`
 * into a `TopologyStore` instance.
 *
 * @template TType String-literal discriminant of the topology store node.
 */
export interface BaseTopologyStoreASTNode<TType extends string = string> {
  /** Unique string-literal discriminant of the topology store node. */
  readonly type: TType;
}
