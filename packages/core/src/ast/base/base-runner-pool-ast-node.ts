/**
 * Domain-agnostic base AST node contract for execution slot and daemon pools (`RunnerPoolASTNode`).
 *
 * Resolved via `RuntimeExecutorRegistry.runners[node.type]` into a memoized `RunnerDriver`
 * separating one-shot command concurrency (`slots`) from long-lived daemon concurrency (`maxDaemons`).
 *
 * @template TType String-literal discriminant of the runner pool node.
 */
export interface BaseRunnerPoolASTNode<TType extends string = string> {
  /** Unique string-literal discriminant of the runner pool node. */
  readonly type: TType;
  /** Logical identifier of the runner pool. */
  readonly id: string;
  /** Maximum concurrent one-shot command slots. */
  readonly slots: number;
  /** Maximum concurrent background daemon sessions. */
  readonly maxDaemons: number;
}
