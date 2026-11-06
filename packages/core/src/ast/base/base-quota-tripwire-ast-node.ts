/**
 * Domain-agnostic base AST node contract for quantitative effect tripwires (`QuotaTripwireASTNode`).
 *
 * Evaluated post-flight after each allowed tool execution via `RuntimeExecutorRegistry.quotaTripwires[node.type]`
 * to trigger `.onLimitExceeded()` epistemic flush sequences when resource quotas are breached.
 *
 * @template TType String-literal discriminant of the quota tripwire node.
 */
export interface BaseQuotaTripwireASTNode<TType extends string = string> {
  /** Unique string-literal discriminant of the quota tripwire node. */
  readonly type: TType;
  /** Logical identifier of the tripwire instance. */
  readonly id: string;
}
