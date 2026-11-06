import type { HumanChannelASTNode } from './domain-ast.types.js';

/**
 * Passive AST node representing an external human authority or notification target (`H.human(id)`).
 *
 * Binds a logical human authority role identifier to either a bidirectional decision channel
 * or a one-way notification channel, along with an optional slot-yielding keep-alive window.
 *
 * @template TMode Interaction mode supported by the underlying human channel (`'bidirectional' | 'notify-only'`).
 */
export interface HumanNode<
  TMode extends 'bidirectional' | 'notify-only' = 'bidirectional' | 'notify-only',
> {
  /** Discriminant identifying a human authority AST node. */
  readonly type: 'harness:human';
  /** Unique identifier of the human authority role. */
  readonly id: string;
  /** Optional keep-alive duration in seconds before yielding a concurrency slot while awaiting a decision. */
  readonly keepAliveSeconds?: number;
  /** Passive human channel AST node (`SlackApproverNode`, `SlackNotifierNode`, or custom channel). */
  readonly channel: HumanChannelASTNode<TMode>;
}
