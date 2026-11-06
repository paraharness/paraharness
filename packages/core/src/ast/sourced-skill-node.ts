import type { ScopePredicate } from '../schemas/core-rules.schema.js';
import type { SourceValue } from './ast-foundation.types.js';
import type { ASTNode } from './ast-node.js';
import type { ServiceASTNode, SourceASTNode, ToolASTNode } from './domain-ast.types.js';
import type { InlineSkillNode } from './inline-skill-node.js';

/**
 * Source-backed `SkillNode` variant loaded from a `SourceASTNode<SkillNode<THandle>>` (such as `md.frontmatter`).
 *
 * Allows loading skill metadata from markdown while binding code-level `unlockedTools` and `unlockedServices`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface SourcedSkillNode<THandle = unknown> extends ASTNode {
  /** Discriminant identifying a skill AST node. */
  readonly type: 'harness:skill';
  /** Unique identifier of the skill. */
  readonly id: string;
  /** External source AST node resolving to a `SkillNode<THandle>` descriptor. */
  readonly source: SourceASTNode<InlineSkillNode<THandle> | SourcedSkillNode<THandle>>;
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
}
