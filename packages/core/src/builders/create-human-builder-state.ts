import type { HumanChannelASTNode } from '../ast/domain-ast.types.js';

/**
 * Optional copy-on-write state for `createHumanBuilder`.
 *
 * Stores the optional `keepAliveSeconds` timeout and the bound `HumanChannelASTNode`.
 *
 * @template TMode Interaction mode.
 */
export interface CreateHumanBuilderState<
  TMode extends 'bidirectional' | 'notify-only' = 'bidirectional' | 'notify-only',
> {
  /** Optional keep-alive duration in seconds. */
  readonly keepAliveSeconds?: number;
  /** Bound human channel AST node. */
  readonly channel?: HumanChannelASTNode<TMode>;
}
