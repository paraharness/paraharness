import type { MaybeBuilder, MaybeSource, SourceValue } from '../ast/ast-foundation.types.js';
import { extractAST } from '../ast/extract-ast.js';
import type { PrefixGroupNode } from '../ast/prefix-group-node.js';
import type { RulesNode } from '../ast/rules-node.js';
import type { CreatePrefixGroupBuilderState as CreatePrefixGroupBuilderOptions } from './create-prefix-group-builder-state.js';
import { assertNonEmptyIdentifier, deepFreeze } from './internal/deep-freeze.js';
import { normalizeMaybeSource } from './internal/normalize-maybe-source.js';
import type { PrefixGroupBuilder } from './prefix-group-builder.js';

/**
 * Creates a fluent `PrefixGroupBuilder` for `M.prefixGroup(id)`.
 *
 * Defaults `toolsMode` to `'role-scoped'` and accumulates `sharedGrounding`,
 * `sharedInstructions`, and `sharedRules` in declaration order.
 *
 * @param {string}                          id        - Unique identifier of the prefix group.
 * @param {CreatePrefixGroupBuilderOptions} [options] - Optional internal copy-on-write state.
 *
 * @returns {PrefixGroupBuilder} Frozen `PrefixGroupBuilder` instance.
 */
export function createPrefixGroupBuilder(
  id: string,
  options?: CreatePrefixGroupBuilderOptions,
): PrefixGroupBuilder {
  assertNonEmptyIdentifier('M.prefixGroup', id);
  const currentToolsMode = options?.toolsMode ?? 'role-scoped';
  const currentGrounding = options?.sharedGrounding ?? Object.freeze([]);
  const currentInstructions = options?.sharedInstructions ?? Object.freeze([]);
  const currentRules = options?.sharedRules;

  return Object.freeze<PrefixGroupBuilder>({
    id,
    toolsMode(mode: 'role-scoped' | 'union'): PrefixGroupBuilder {
      return createPrefixGroupBuilder(id, {
        toolsMode: mode,
        sharedGrounding: currentGrounding,
        sharedInstructions: currentInstructions,
        sharedRules: currentRules,
      });
    },
    sharedGrounding(...sources: ReadonlyArray<MaybeSource<string>>): PrefixGroupBuilder {
      const next: SourceValue<string>[] = [...currentGrounding];
      for (const src of sources) {
        next.push(normalizeMaybeSource(src));
      }
      return createPrefixGroupBuilder(id, {
        toolsMode: currentToolsMode,
        sharedGrounding: Object.freeze(next),
        sharedInstructions: currentInstructions,
        sharedRules: currentRules,
      });
    },
    sharedInstructions(...sources: ReadonlyArray<MaybeSource<string>>): PrefixGroupBuilder {
      const next: SourceValue<string>[] = [...currentInstructions];
      for (const src of sources) {
        next.push(normalizeMaybeSource(src));
      }
      return createPrefixGroupBuilder(id, {
        toolsMode: currentToolsMode,
        sharedGrounding: currentGrounding,
        sharedInstructions: Object.freeze(next),
        sharedRules: currentRules,
      });
    },
    sharedRules(rules: MaybeBuilder<RulesNode>): PrefixGroupBuilder {
      return createPrefixGroupBuilder(id, {
        toolsMode: currentToolsMode,
        sharedGrounding: currentGrounding,
        sharedInstructions: currentInstructions,
        sharedRules: extractAST(rules),
      });
    },
    toAST(): PrefixGroupNode {
      return deepFreeze<PrefixGroupNode>({
        type: 'harness:prefix-group',
        id,
        toolsMode: currentToolsMode,
        sharedGrounding: currentGrounding,
        sharedInstructions: currentInstructions,
        sharedRules: currentRules,
      });
    },
  });
}
