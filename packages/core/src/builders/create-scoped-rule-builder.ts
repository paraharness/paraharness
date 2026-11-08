import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type { SourceASTNode } from '../ast/domain-ast.types.js';
import type { ScopedRule } from '../schemas/core-rules.schema.js';
import type { CreateScopedRuleBuilderState as CreateScopedRuleBuilderOptions } from './create-scoped-rule-builder-state.js';
import { buildScopedRuleFromState } from './internal/build-scoped-rule-from-state.js';
import type { ScopedRuleBuilder } from './scoped-rule-builder.js';

/**
 * Creates a fluent `ScopedRuleBuilder` for `M.scopedRule(idOrSource)`.
 *
 * Delegates to `buildScopedRuleFromState` to support both inline scoped rules and
 * frontmatter-sourced scoped rule definitions.
 *
 * @param {string | MaybeBuilder<SourceASTNode<ScopedRule>>} idOrSource - String identifier or frontmatter rule source.
 * @param {CreateScopedRuleBuilderOptions}                   [options]  - Optional internal copy-on-write state.
 *
 * @returns {ScopedRuleBuilder} Frozen `ScopedRuleBuilder` instance.
 */
export function createScopedRuleBuilder(
  idOrSource: string | MaybeBuilder<SourceASTNode<ScopedRule>>,
  options?: CreateScopedRuleBuilderOptions,
): ScopedRuleBuilder {
  return buildScopedRuleFromState(idOrSource, options);
}
