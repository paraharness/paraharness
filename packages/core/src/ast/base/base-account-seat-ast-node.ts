/**
 * Domain-agnostic base AST node contract for LLM provider account seats (`AccountSeatASTNode`).
 *
 * Multiplexed inside `PoolNode` with run-sticky seat affinity to preserve per-account KV prefix
 * caches and server-side conversation state across turns and forks.
 *
 * @template TType String-literal discriminant of the account seat node.
 */
export interface BaseAccountSeatASTNode<TType extends string = string> {
  /** Unique string-literal discriminant of the account seat node. */
  readonly type: TType;
  /** Logical identifier of the account seat. */
  readonly id: string;
}
