import type { MaybeBuilder, MaybeSource } from '../ast/ast-foundation.types.js';
import type { ServiceASTNode, SourceASTNode, ToolASTNode } from '../ast/domain-ast.types.js';
import { extractAST } from '../ast/extract-ast.js';
import type { SkillNode } from '../ast/skill-node.types.js';
import type { CreateSkillBuilderState } from './create-skill-builder-state.js';
import { assertNonEmptyIdentifier, deepFreeze } from './internal/deep-freeze.js';
import { flattenExtractedNodes } from './internal/flatten-builder-inputs.js';
import { normalizeMaybeSource } from './internal/normalize-maybe-source.js';
import { normalizeScopePredicateInput, resolveSourceRuleId } from './internal/normalize-scope-predicate-input.js';
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
 * @param {CreateSkillBuilderState<THandle>}                         [options]  - Optional internal copy-on-write state.
 *
 * @returns {SkillBuilder<THandle>} Frozen `SkillBuilder` instance.
 */
export function createSkillBuilder<THandle = unknown>(
  idOrSource: string | MaybeBuilder<SourceASTNode<SkillNode<THandle>>>,
  options?: CreateSkillBuilderState<THandle>,
): SkillBuilder<THandle> {
  const isStringId = typeof idOrSource === 'string';
  const sourceNode = isStringId ? options?.source : extractAST(idOrSource);
  const resolvedId = isStringId ? idOrSource : sourceNode !== undefined ? resolveSourceRuleId(sourceNode, 'sourced-skill') : 'sourced-skill';
  assertNonEmptyIdentifier('H.skill', resolvedId);
  const currentTools = options?.unlockedTools ?? Object.freeze([]);
  const currentServices = options?.unlockedServices ?? Object.freeze([]);
  const currentLeaseMode = options?.leaseMode ?? 'until-completed-or-fork-exit';

  return Object.freeze<SkillBuilder<THandle>>({
    id: resolvedId,
    when: (predicate: ScopePredicateInput) =>
      createSkillBuilder<THandle>(resolvedId, { ...options, source: sourceNode, when: normalizeScopePredicateInput(predicate) }),
    description: (text: string) =>
      createSkillBuilder<THandle>(resolvedId, { ...options, source: sourceNode, description: text }),
    instructions: (instructionsSource: MaybeSource<string>) =>
      createSkillBuilder<THandle>(resolvedId, { ...options, source: sourceNode, instructions: normalizeMaybeSource(instructionsSource) }),
    unlocksTools: (
      ...tools: ReadonlyArray<MaybeBuilder<ToolASTNode<THandle>> | ReadonlyArray<MaybeBuilder<ToolASTNode<THandle>>>>
    ) =>
      createSkillBuilder<THandle>(resolvedId, {
        ...options,
        source: sourceNode,
        unlockedTools: Object.freeze([...currentTools, ...flattenExtractedNodes(tools)]),
      }),
    unlocksServices: (
      ...services: ReadonlyArray<MaybeBuilder<ServiceASTNode<THandle>> | ReadonlyArray<MaybeBuilder<ServiceASTNode<THandle>>>>
    ) =>
      createSkillBuilder<THandle>(resolvedId, {
        ...options,
        source: sourceNode,
        unlockedServices: Object.freeze([...currentServices, ...flattenExtractedNodes(services)]),
      }),
    lease: (mode: 'until-completed-or-fork-exit') =>
      createSkillBuilder<THandle>(resolvedId, { ...options, source: sourceNode, leaseMode: mode }),
    toAST(): SkillNode<THandle> {
      const base = {
        type: 'harness:skill' as const,
        id: resolvedId,
        when: options?.when,
        unlockedTools: currentTools,
        unlockedServices: currentServices,
        leaseMode: currentLeaseMode,
      };
      if (sourceNode !== undefined) {
        return deepFreeze<SkillNode<THandle>>({ ...base, source: sourceNode, description: options?.description, instructions: options?.instructions });
      }
      if (options?.description === undefined || options.instructions === undefined) {
        throw new Error(`Inline skill '${resolvedId}' requires both .description(...) and .instructions(...).`);
      }
      return deepFreeze<SkillNode<THandle>>({ ...base, source: undefined, description: options.description, instructions: options.instructions });
    },
  });
}
