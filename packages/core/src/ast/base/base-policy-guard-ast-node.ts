/**
 * Domain-agnostic base AST node contract for pre-flight and post-flight policy guards (`PolicyGuardASTNode`).
 *
 * Evaluated by `RuntimeExecutorRegistry.policyGuards[node.type]` over `ToolEffect` descriptors
 * and active capability leases (`LeaseDelta`).
 *
 * @template TType String-literal discriminant of the policy guard node.
 */
export interface BasePolicyGuardASTNode<TType extends string = string> {
  /** Unique string-literal discriminant of the policy guard node. */
  readonly type: TType;
  /** Logical identifier of the guard instance. */
  readonly id: string;
}
