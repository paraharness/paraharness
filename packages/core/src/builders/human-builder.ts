import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type { AstBuilder } from '../ast/ast-builder.js';
import type { HumanChannelASTNode } from '../ast/domain-ast.types.js';
import type { HumanNode } from '../ast/human-node.js';
import type { ScopedHumanNameBuilder } from './scoped-human-name-builder.js';

/**
 * Fluent builder for external human authorities and notification channels (`P.human(id)`).
 *
 * Tracks the channel interaction mode (`'bidirectional' | 'notify-only'`) at the type
 * level so `.ask()`, `.escalate()`, and `.maxCostUsd()` reject notify-only channels.
 *
 * @template TMode Interaction mode of the bound channel (`'bidirectional' | 'notify-only'`).
 */
export interface HumanBuilder<
  TMode extends 'bidirectional' | 'notify-only' = 'bidirectional' | 'notify-only',
> extends AstBuilder<HumanNode<TMode>> {
  /** Unique identifier of the human authority role. */
  readonly id: string;

  /**
   * Sets the keep-alive duration in seconds before yielding a concurrency slot while awaiting a human decision.
   *
   * When a human response takes longer than `seconds`, the runtime checkpoints and releases the active slot.
   *
   * @param {number} seconds - Positive keep-alive duration in seconds.
   *
   * @returns {HumanBuilder<TMode>} New immutable human builder.
   */
  keepAliveSeconds(seconds: number): HumanBuilder<TMode>;

  /**
   * Binds the underlying `HumanChannelASTNode` (`slack.bot(...)` or `slack.webhook(...)`) used to reach the human.
   *
   * Narrows the builder's `TMode` type parameter to the channel's `interactionMode`.
   *
   * @template TNextMode Interaction mode of `channel` (`'bidirectional' | 'notify-only'`).
   *
   * @param {MaybeBuilder<HumanChannelASTNode<TNextMode>>} channel - Human channel AST node or builder.
   *
   * @returns {HumanBuilder<TNextMode>} New immutable human builder narrowed to `TNextMode`.
   */
  notify<TNextMode extends 'bidirectional' | 'notify-only'>(
    channel: MaybeBuilder<HumanChannelASTNode<TNextMode>>,
  ): HumanBuilder<TNextMode>;

  /**
   * Creates a role-aliased human target builder (`human.withName(alias).output(schema)`).
   *
   * Used to bind a named decision role and response schema to a bidirectional human authority.
   *
   * @param {string} alias - Role alias for the decision target (e.g. `'budget-approver'`).
   *
   * @returns {ScopedHumanNameBuilder} Intermediate builder requiring `.output(schema)`.
   */
  withName(alias: string): ScopedHumanNameBuilder;
}
