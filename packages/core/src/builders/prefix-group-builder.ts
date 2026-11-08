import type { MaybeBuilder, MaybeSource } from '../ast/ast-foundation.types.js';
import type { AstBuilder } from '../ast/ast-builder.js';
import type { PrefixGroupNode } from '../ast/prefix-group-node.js';
import type { RulesNode } from '../ast/rules-node.js';

/**
 * Fluent builder for run-immutable KV-cache prompt prefix groups (`M.prefixGroup(id)`).
 *
 * Defines the shared `toolsMode`, `sharedGrounding`, `sharedInstructions`, and `sharedRules`
 * pinned in Slot 1 of the 4-slot wire compilation order.
 */
export interface PrefixGroupBuilder extends AstBuilder<PrefixGroupNode> {
  /** Unique identifier of the prefix group. */
  readonly id: string;

  /**
   * Configures whether wire `tools` arrays are cached per role (`'role-scoped'`, default) or unified across all roles (`'union'`).
   *
   * Required to be `'union'` when any member agent uses `historyMode: 'clone-transcript'` forks with differing toolsets.
   *
   * @param {'role-scoped' | 'union'} mode - Wire tool schema caching mode.
   *
   * @returns {PrefixGroupBuilder} New immutable prefix group builder.
   */
  toolsMode(mode: 'role-scoped' | 'union'): PrefixGroupBuilder;

  /**
   * Appends shared grounding files or inline strings pinned at the top of the wire `system` prompt in declaration order.
   *
   * Sources are resolved once at run start and frozen for the lifetime of the run.
   *
   * @param {...ReadonlyArray<MaybeSource<string>>} sources - Grounding sources or strings.
   *
   * @returns {PrefixGroupBuilder} New immutable prefix group builder.
   */
  sharedGrounding(...sources: ReadonlyArray<MaybeSource<string>>): PrefixGroupBuilder;

  /**
   * Appends shared instruction sources or inline strings pinned in the wire `system` prompt in declaration order.
   *
   * Appears immediately after `sharedGrounding` in the compiled wire `system` prompt.
   *
   * @param {...ReadonlyArray<MaybeSource<string>>} sources - Instruction sources or strings.
   *
   * @returns {PrefixGroupBuilder} New immutable prefix group builder.
   */
  sharedInstructions(...sources: ReadonlyArray<MaybeSource<string>>): PrefixGroupBuilder;

  /**
   * Binds a shared `RulesNode` whose `globalRules` are pinned in the wire `system` prompt.
   *
   * Ensures every agent sharing this prefix group sees an identical `[GLOBAL_RULES]` block.
   *
   * @param {MaybeBuilder<RulesNode>} rules - Compiled `RulesNode` or `M.rules(...)` builder.
   *
   * @returns {PrefixGroupBuilder} New immutable prefix group builder.
   */
  sharedRules(rules: MaybeBuilder<RulesNode>): PrefixGroupBuilder;
}
