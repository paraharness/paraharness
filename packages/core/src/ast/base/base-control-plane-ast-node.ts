/**
 * Domain-agnostic base AST node contract for exposed control-plane servers (`ControlPlaneASTNode`).
 *
 * Resolved via `RuntimeExecutorRegistry.controlPlanes[node.type]` into a `ControlPlaneAdapter`
 * started by `M.harness.expose()`.
 *
 * @template TType String-literal discriminant of the control-plane node.
 */
export interface BaseControlPlaneASTNode<TType extends string = string> {
  /** Unique string-literal discriminant of the control-plane node. */
  readonly type: TType;
}
