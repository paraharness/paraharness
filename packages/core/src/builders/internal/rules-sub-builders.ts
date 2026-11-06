import type { MaybeBuilder, MaybeSource } from '../../ast/ast-foundation.types.js';
import type { CheckASTNode, SourceASTNode } from '../../ast/domain-ast.types.js';
import { extractAST } from '../../ast/extract-ast.js';
import type { ScopedRuleNode } from '../../ast/scoped-rule-node.types.js';
import type { ScopedRule } from '../../schemas/core-rules.schema.js';
import type { CreateScopedRuleBuilderState as CreateScopedRuleBuilderOptions } from '../create-scoped-rule-builder-state.js';
import type { ScopePredicateInput } from '../scope-predicate-input.js';
import type { ScopedRuleBuilder } from '../scoped-rule-builder.js';
import { assertNonEmptyIdentifier, deepFreeze } from './deep-freeze.js';
import { normalizeMaybeSource } from './normalize-maybe-source.js';
import {
  normalizeScopePredicateInput,
  resolveSourceRuleId,
} from './normalize-scope-predicate-input.js';

/**
 * Creates a fluent `ScopedRuleBuilder` from an identifier or source node and optional state.
 *
 * Supports both inline scoped rules (requiring `.when()` and `.directive()`) and
 * frontmatter-sourced scoped rules with optional `.when()`, `.directive()`, and
 * `.enforceBeforeStop()` overrides.
 *
 * @param {string | MaybeBuilder<SourceASTNode<ScopedRule>>} idOrSource - String identifier or frontmatter rule source.
 * @param {CreateScopedRuleBuilderOptions}                   [options]  - Optional internal copy-on-write state.
 *
 * @returns {ScopedRuleBuilder} Frozen `ScopedRuleBuilder` instance.
 */
export function buildScopedRuleFromState(
  idOrSource: string | MaybeBuilder<SourceASTNode<ScopedRule>>,
  options?: CreateScopedRuleBuilderOptions,
): ScopedRuleBuilder {
  const isStringId = typeof idOrSource === 'string';
  const sourceNode = isStringId ? options?.source : extractAST(idOrSource);
  const resolvedId = isStringId
    ? idOrSource
    : sourceNode !== undefined
      ? resolveSourceRuleId(sourceNode)
      : 'sourced-scoped-rule';
  assertNonEmptyIdentifier('H.scopedRule', resolvedId);
  const currentChecks: readonly CheckASTNode<unknown>[] =
    options?.enforceBeforeStopChecks ?? Object.freeze([]);

  return Object.freeze<ScopedRuleBuilder>({
    id: resolvedId,
    when(predicate: ScopePredicateInput): ScopedRuleBuilder {
      return buildScopedRuleFromState(resolvedId, {
        source: sourceNode,
        when: normalizeScopePredicateInput(predicate),
        directive: options?.directive,
        enforceBeforeStopChecks: currentChecks,
      });
    },
    directive(directiveSource: MaybeSource<string>): ScopedRuleBuilder {
      return buildScopedRuleFromState(resolvedId, {
        source: sourceNode,
        when: options?.when,
        directive: normalizeMaybeSource(directiveSource),
        enforceBeforeStopChecks: currentChecks,
      });
    },
    enforceBeforeStop<THandle = unknown>(
      ...checks: ReadonlyArray<MaybeBuilder<CheckASTNode<THandle>>>
    ): ScopedRuleBuilder {
      const nextChecks: CheckASTNode<unknown>[] = [...currentChecks];
      for (const check of checks) {
        nextChecks.push(extractAST(check));
      }
      return buildScopedRuleFromState(resolvedId, {
        source: sourceNode,
        when: options?.when,
        directive: options?.directive,
        enforceBeforeStopChecks: Object.freeze(nextChecks),
      });
    },
    toAST(): ScopedRuleNode {
      if (sourceNode !== undefined) {
        return deepFreeze<ScopedRuleNode>({
          type: 'harness:scoped-rule',
          id: resolvedId,
          source: sourceNode,
          when: options?.when,
          directive: options?.directive,
          enforceBeforeStopChecks: currentChecks,
        });
      }
      if (options?.when === undefined || options.directive === undefined) {
        throw new Error(
          `Inline scoped rule '${resolvedId}' requires both .when(...) and .directive(...).`,
        );
      }
      return deepFreeze<ScopedRuleNode>({
        type: 'harness:scoped-rule',
        id: resolvedId,
        source: undefined,
        when: options.when,
        directive: options.directive,
        enforceBeforeStopChecks: currentChecks,
      });
    },
  });
}
