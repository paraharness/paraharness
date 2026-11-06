import type { SourceValue } from '../ast/ast-foundation.types.js';
import type {
  ServiceASTNode,
  SourceASTNode,
  ToolASTNode,
} from '../ast/domain-ast.types.js';
import type { SkillNode } from '../ast/skill-node.types.js';
import type { ScopePredicate } from '../schemas/core-rules.schema.js';

/**
 * Optional copy-on-write state for `createSkillBuilder`.
 *
 * Captures the optional frontmatter skill source, scope predicate, catalog description,
 * procedural instructions, unlocked tools/services, and lease lifecycle mode.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface CreateSkillBuilderState<THandle = unknown> {
  /** External frontmatter skill source when wrapping `md.skill(...)`. */
  readonly source?: SourceASTNode<SkillNode<THandle>>;
  /** Optional scope predicate. */
  readonly when?: ScopePredicate;
  /** Optional catalog description. */
  readonly description?: string;
  /** Optional procedural instructions. */
  readonly instructions?: SourceValue<string>;
  /** Unlocked tools. */
  readonly unlockedTools?: readonly ToolASTNode<THandle>[];
  /** Unlocked background daemon services. */
  readonly unlockedServices?: readonly ServiceASTNode<THandle>[];
  /** Lease lifecycle mode. */
  readonly leaseMode?: 'until-completed-or-fork-exit';
}
