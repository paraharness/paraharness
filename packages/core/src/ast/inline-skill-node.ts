import type { ScopePredicate } from '../schemas/core-rules.schema.js';
import type { SourceValue } from './ast-foundation.types.js';
import type { ASTNode } from './ast-node.js';
import type { ServiceASTNode, ToolASTNode } from './domain-ast.types.js';

/**
 * Inline `SkillNode` variant whose `description` and `instructions` are configured directly on `H.skill(id)`.
 *
 * Unlocks `unlockedTools` and `unlockedServices` when activated via `activateSkill({ skillId })`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface InlineSkillNode<THandle = unknown> extends ASTNode {
  /** Discriminant identifying a skill AST node. */
  readonly type: 'harness:skill';
  /** Unique identifier of the skill. */
  readonly id: string;
  /** Undefined on inline skills. */
  readonly source?: undefined;
  /** Optional scope predicate (`partitions` or reactive `effects`) highlighting the skill in context. */
  readonly when?: ScopePredicate;
  /** Short catalog description presented in the Turn-0 `[ROLE_AND_SCOPE_CONTEXT]` frame. */
  readonly description: string;
  /** Detailed procedural instructions returned when `activateSkill({ skillId })` is invoked. */
  readonly instructions: SourceValue<string>;
  /** Tools unlocked when this skill is activated. */
  readonly unlockedTools: readonly ToolASTNode<THandle>[];
  /** Background daemon services started and mounted when this skill is activated. */
  readonly unlockedServices: readonly ServiceASTNode<THandle>[];
  /** Lease lifecycle mode governing when the skill's tools and services are unmounted. */
  readonly leaseMode: 'until-completed-or-fork-exit';
}
