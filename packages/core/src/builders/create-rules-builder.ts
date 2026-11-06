import type { MaybeBuilder, MaybeSource, SourceValue } from '../ast/ast-foundation.types.js';
import type { RulesNode } from '../ast/rules-node.js';
import type { ScopedRuleNode } from '../ast/scoped-rule-node.js';
import type { GlobalRule, ScopedRule } from '../schemas/core-rules.schema.js';
import type { CreateRulesBuilderOptions } from './create-rules-builder-state.js';
import { assertNonEmptyIdentifier, deepFreeze } from './internal/deep-freeze.js';
import { normalizeMaybeSource } from './internal/normalize-maybe-source.js';
import { hasToAstMethod } from './internal/rules-sub-builders.js';
import type { RulesBuilder } from './rules-builder.js';

/**
 * Creates a fluent `RulesBuilder` for `H.rules(id)`.
 *
 * Accumulates `globalRules` and `scopedRules` in declaration order and compiles into
 * a deeply frozen `RulesNode`.
 *
 * @param {string}                    id        - Unique identifier of the rules registry.
 * @param {CreateRulesBuilderOptions} [options] - Optional internal copy-on-write state.
 *
 * @returns {RulesBuilder} Frozen `RulesBuilder` instance.
 */
export function createRulesBuilder(
  id: string,
  options?: CreateRulesBuilderOptions,
): RulesBuilder {
  assertNonEmptyIdentifier('H.rules', id);
  const currentGlobal = options?.globalRules ?? Object.freeze([]);
  const currentScoped = options?.scopedRules ?? Object.freeze([]);

  return Object.freeze<RulesBuilder>({
    id,
    global(
      ...rules: ReadonlyArray<MaybeSource<GlobalRule | readonly GlobalRule[]>>
    ): RulesBuilder {
      const next: SourceValue<GlobalRule | readonly GlobalRule[]>[] = [...currentGlobal];
      for (const rule of rules) {
        next.push(normalizeMaybeSource(rule));
      }
      return createRulesBuilder(id, {
        globalRules: Object.freeze(next),
        scopedRules: currentScoped,
      });
    },
    scoped(
      ...rules: ReadonlyArray<
        MaybeBuilder<ScopedRuleNode> | MaybeSource<ScopedRule | readonly ScopedRule[]>
      >
    ): RulesBuilder {
      const next: Array<ScopedRuleNode | SourceValue<ScopedRule | readonly ScopedRule[]>> = [
        ...currentScoped,
      ];
      for (const rule of rules) {
        next.push(hasToAstMethod(rule) ? rule.toAST() : rule);
      }
      return createRulesBuilder(id, {
        globalRules: currentGlobal,
        scopedRules: Object.freeze(next),
      });
    },
    toAST(): RulesNode {
      return deepFreeze<RulesNode>({
        type: 'harness:rules',
        id,
        globalRules: currentGlobal,
        scopedRules: currentScoped,
      });
    },
  });
}
