/**
 * Domain-agnostic base AST node contract for capability lease effect matchers (`EffectMatcherASTNode`).
 *
 * Evaluated via `RuntimeExecutorRegistry.effectMatchers[node.type]` to test whether a `ToolEffect`
 * is covered by a `LeaseDelta` or matches a reactive scoped rule/skill `when.effects` predicate.
 *
 * @template TType String-literal discriminant of the effect matcher node.
 */
export interface BaseEffectMatcherASTNode<TType extends string = string> {
  /** Unique string-literal discriminant of the effect matcher node. */
  readonly type: TType;
  /** Logical identifier of the effect matcher instance. */
  readonly id: string;
}
