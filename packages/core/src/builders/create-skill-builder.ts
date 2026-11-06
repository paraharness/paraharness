import type { MaybeBuilder, MaybeSource } from '../ast/ast-foundation.types.js';
import type {
  ServiceASTNode,
  SourceASTNode,
  ToolASTNode,
} from '../ast/domain-ast.types.js';
import { extractAST } from '../ast/extract-ast.js';
import type { SkillNode } from '../ast/skill-node.types.js';
import type { CreateSkillBuilderOptions } from './create-skill-builder-state.js';
import { flattenExtractedNodes } from './internal/agent-and-loop-sub-builders.js';
import { assertNonEmptyIdentifier, deepFreeze } from './internal/deep-freeze.js';
import { normalizeMaybeSource } from './internal/normalize-maybe-source.js';
import { normalizeScopePredicateInput } from './internal/rules-sub-builders.js';
import type { ScopePredicateInput } from './scope-predicate-input.js';
import type { SkillBuilder } from './skill-builder.js';

/**
 * Creates a fluent `SkillBuilder` for `H.skill(idOrSource)`.
 *
 * Supports both inline skill definitions (requiring `.description()` and `.instructions()`)
 * and frontmatter-sourced skill definitions with optional tool and service unlocks.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {string | MaybeBuilder<SourceASTNode<SkillNode<THandle>>>} idOrSource - Skill identifier string or frontmatter skill source.
 * @param {CreateSkillBuilderOptions<THandle>}                       [options]  - Optional internal copy-on-write state.
 *
 * @returns {SkillBuilder<THandle>} Frozen `SkillBuilder` instance.
 */
export function createSkillBuilder<THandle = unknown>(
  idOrSource: string | MaybeBuilder<SourceASTNode<SkillNode<THandle>>>,
  options?: CreateSkillBuilderOptions<THandle>,
): SkillBuilder<THandle> {
  const isStringId = typeof idOrSource === 'string';
  const sourceNode = isStringId ? options?.source : extractAST(idOrSource);
  const resolvedId = isStringId
    ? idOrSource
    : ((sourceNode as { readonly path?: string } | undefined)?.path ?? 'sourced-skill');
  assertNonEmptyIdentifier('H.skill', resolvedId);

  const currentTools = options?.unlockedTools ?? Object.freeze([]);
  const currentServices = options?.unlockedServices ?? Object.freeze([]);
  const currentLeaseMode = options?.leaseMode ?? 'until-completed-or-fork-exit';

  return Object.freeze<SkillBuilder<THandle>>({
    id: resolvedId,
    when(predicate: ScopePredicateInput): SkillBuilder<THandle> {
      return createSkillBuilder<THandle>(resolvedId, {
        ...options,
        source: sourceNode,
        when: normalizeScopePredicateInput(predicate),
      });
    },
    description(text: string): SkillBuilder<THandle> {
      return createSkillBuilder<THandle>(resolvedId, {
        ...options,
        source: sourceNode,
        description: text,
      });
    },
    instructions(instructionsSource: MaybeSource<string>): SkillBuilder<THandle> {
      return createSkillBuilder<THandle>(resolvedId, {
        ...options,
        source: sourceNode,
        instructions: normalizeMaybeSource(instructionsSource),
      });
    },
    unlocksTools(
      ...tools: ReadonlyArray<
        MaybeBuilder<ToolASTNode<THandle>> | ReadonlyArray<MaybeBuilder<ToolASTNode<THandle>>>
      >
    ): SkillBuilder<THandle> {
      return createSkillBuilder<THandle>(resolvedId, {
        ...options,
        source: sourceNode,
        unlockedTools: Object.freeze([...currentTools, ...flattenExtractedNodes(tools)]),
      });
    },
    unlocksServices(
      ...services: ReadonlyArray<
        MaybeBuilder<ServiceASTNode<THandle>> | ReadonlyArray<MaybeBuilder<ServiceASTNode<THandle>>>
      >
    ): SkillBuilder<THandle> {
      return createSkillBuilder<THandle>(resolvedId, {
        ...options,
        source: sourceNode,
        unlockedServices: Object.freeze([
          ...currentServices,
          ...flattenExtractedNodes(services),
        ]),
      });
    },
    lease(mode: 'until-completed-or-fork-exit'): SkillBuilder<THandle> {
      return createSkillBuilder<THandle>(resolvedId, {
        ...options,
        source: sourceNode,
        leaseMode: mode,
      });
    },
    toAST(): SkillNode<THandle> {
      if (sourceNode !== undefined) {
        return deepFreeze<SkillNode<THandle>>({
          type: 'harness:skill',
          id: resolvedId,
          source: sourceNode,
          when: options?.when,
          description: options?.description,
          instructions: options?.instructions,
          unlockedTools: currentTools,
          unlockedServices: currentServices,
          leaseMode: currentLeaseMode,
        });
      }
      if (options?.description === undefined || options.instructions === undefined) {
        throw new Error(
          `Inline skill '${resolvedId}' requires both .description(...) and .instructions(...).`,
        );
      }
      return deepFreeze<SkillNode<THandle>>({
        type: 'harness:skill',
        id: resolvedId,
        source: undefined,
        when: options.when,
        description: options.description,
        instructions: options.instructions,
        unlockedTools: currentTools,
        unlockedServices: currentServices,
        leaseMode: currentLeaseMode,
      });
    },
  });
}
