/**
 * Domain-agnostic base AST node contract for human notification and decision channels (`HumanChannelASTNode`).
 *
 * Carries `interactionMode` (`'bidirectional'` vs `'notify-only'`) so `M.human`, `.ask()`,
 * `.escalate()`, and `M.lane.maxCostUsd()` can statically reject notify-only channels when
 * interactive decisions are required.
 *
 * @template TType String-literal discriminant of the human channel node.
 * @template TMode Channel interaction mode (`'bidirectional' | 'notify-only'`).
 */
export interface BaseHumanChannelASTNode<
  TType extends string = string,
  TMode extends 'bidirectional' | 'notify-only' = 'bidirectional' | 'notify-only',
> {
  /** Unique string-literal discriminant of the human channel node. */
  readonly type: TType;
  /** Declarative interaction capability of the channel. */
  readonly interactionMode: TMode;
}
