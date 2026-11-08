import type { MaybeBuilder, MaybeSource } from '../ast/ast-foundation.types.js';
import type { AstBuilder } from '../ast/ast-builder.js';
import type {
  ServiceASTNode,
  ToolASTNode,
} from '../ast/domain-ast.types.js';
import type { SkillNode } from '../ast/skill-node.types.js';
import type { ScopePredicateInput } from './scope-predicate-input.js';

/**
 * Fluent builder for pull-based procedural skills (`M.skill(idOrSource)`).
 *
 * Configures catalog descriptions, procedural instructions, dynamically unlocked tools
 * and background daemon services, and lease lifecycle modes.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface SkillBuilder<THandle = unknown> extends AstBuilder<SkillNode<THandle>> {
  /** Unique identifier of the skill. */
  readonly id: string;

  /**
   * Configures optional partition and/or reactive effect predicates that highlight this skill in context.
   *
   * Highlighted skills remain pull-based via `activateSkill({ skillId })` until explicitly unlocked.
   *
   * @param {ScopePredicateInput} predicate - Partition list and optional effect matcher.
   *
   * @returns {SkillBuilder<THandle>} New immutable skill builder.
   */
  when(predicate: ScopePredicateInput): SkillBuilder<THandle>;

  /**
   * Sets the short catalog description displayed in the Turn-0 `[ROLE_AND_SCOPE_CONTEXT]` frame.
   *
   * Required for inline skills so the model knows when to pull the skill via `activateSkill`.
   *
   * @param {string} text - Concise catalog description explaining when to pull the skill.
   *
   * @returns {SkillBuilder<THandle>} New immutable skill builder.
   */
  description(text: string): SkillBuilder<THandle>;

  /**
   * Sets the detailed procedural instructions returned when `activateSkill({ skillId })` is called.
   *
   * Accepts an inline string or a `SourceASTNode<string>` resolved at activation time.
   *
   * @param {MaybeSource<string>} instructionsSource - Inline instruction string or `SourceASTNode<string>`.
   *
   * @returns {SkillBuilder<THandle>} New immutable skill builder.
   */
  instructions(instructionsSource: MaybeSource<string>): SkillBuilder<THandle>;

  /**
   * Registers tools unlocked while this skill is active.
   *
   * Unlocked tools become callable by the agent on subsequent turns after `activateSkill` succeeds.
   *
   * @param {...ReadonlyArray<MaybeBuilder<ToolASTNode<THandle>> | ReadonlyArray<MaybeBuilder<ToolASTNode<THandle>>>>} tools - Tool AST nodes, builders, or tool bundles.
   *
   * @returns {SkillBuilder<THandle>} New immutable skill builder.
   */
  unlocksTools(
    ...tools: ReadonlyArray<
      MaybeBuilder<ToolASTNode<THandle>> | ReadonlyArray<MaybeBuilder<ToolASTNode<THandle>>>
    >
  ): SkillBuilder<THandle>;

  /**
   * Registers background daemon services started and mounted while this skill is active.
   *
   * Services are started when the skill is activated and stopped when the skill lease expires.
   *
   * @param {...ReadonlyArray<MaybeBuilder<ServiceASTNode<THandle>> | ReadonlyArray<MaybeBuilder<ServiceASTNode<THandle>>>>} services - Service AST nodes or builders.
   *
   * @returns {SkillBuilder<THandle>} New immutable skill builder.
   */
  unlocksServices(
    ...services: ReadonlyArray<
      MaybeBuilder<ServiceASTNode<THandle>> | ReadonlyArray<MaybeBuilder<ServiceASTNode<THandle>>>
    >
  ): SkillBuilder<THandle>;

  /**
   * Sets the lease lifecycle mode for tools and services unlocked by this skill.
   *
   * Defaults to `'until-completed-or-fork-exit'` so unlocked tools remain available until step completion.
   *
   * @param {'until-completed-or-fork-exit'} mode - Lease lifecycle mode.
   *
   * @returns {SkillBuilder<THandle>} New immutable skill builder.
   */
  lease(mode: 'until-completed-or-fork-exit'): SkillBuilder<THandle>;
}
