import type { ScopePredicate } from '../schemas/core-rules.schema.js';
import type { SourceValue } from './ast-foundation.types.js';
import type { ServiceASTNode, SourceASTNode, ToolASTNode } from './domain-ast.types.js';

/**
 * Inline `SkillNode` variant whose `description` and `instructions` are configured directly on `H.skill(id)`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export type InlineSkillNode<THandle = unknown> = {
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
};

/**
 * Source-backed `SkillNode` variant loaded from a `SourceASTNode<SkillNode<THandle>>` (such as `md.frontmatter`).
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export type SourcedSkillNode<THandle = unknown> = {
  /** Discriminant identifying a skill AST node. */
  readonly type: 'harness:skill';
  /** Unique identifier of the skill. */
  readonly id: string;
  /** External source AST node resolving to a `SkillNode<THandle>` descriptor. */
  readonly source: SourceASTNode<SkillNode<THandle>>;
  /** Optional code-level scope predicate overriding or augmenting frontmatter `when`. */
  readonly when?: ScopePredicate;
  /** Optional code-level catalog description overriding frontmatter `description`. */
  readonly description?: string;
  /** Optional code-level procedural instructions overriding frontmatter body. */
  readonly instructions?: SourceValue<string>;
  /** Tools unlocked when this skill is activated. */
  readonly unlockedTools: readonly ToolASTNode<THandle>[];
  /** Background daemon services started and mounted when this skill is activated. */
  readonly unlockedServices: readonly ServiceASTNode<THandle>[];
  /** Lease lifecycle mode governing when the skill's tools and services are unmounted. */
  readonly leaseMode: 'until-completed-or-fork-exit';
};

/**
 * Passive AST node representing an on-demand procedural skill (`H.skill(...)`).
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export type SkillNode<THandle = unknown> = InlineSkillNode<THandle> | SourcedSkillNode<THandle>;
