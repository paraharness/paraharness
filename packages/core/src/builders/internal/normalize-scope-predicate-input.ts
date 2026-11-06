import type { MaybeBuilder, MaybeSource } from '../../ast/ast-foundation.types.js';
import type { AstBuilder } from '../../ast/ast-builder.js';
import type { SourceASTNode } from '../../ast/domain-ast.types.js';
import { extractAST } from '../../ast/extract-ast.js';
import type { ScopedRuleNode } from '../../ast/scoped-rule-node.types.js';
import type { ScopePredicate, ScopedRule } from '../../schemas/core-rules.schema.js';
import type { ScopePredicateInput } from '../scope-predicate-input.js';
import { deepFreeze } from './deep-freeze.js';

/**
 * Normalizes a `ScopePredicateInput` into a frozen `ScopePredicate` record.
 *
 * Copies any provided partition globs into a frozen array and extracts the underlying
 * `EffectPredicateASTNode` when `effects` is supplied.
 *
 * @param {ScopePredicateInput} input - Raw scope predicate input from `.when(...)`.
 *
 * @returns {ScopePredicate} Normalized `ScopePredicate` record.
 */
export function normalizeScopePredicateInput(input: ScopePredicateInput): ScopePredicate {
  return deepFreeze<ScopePredicate>({
    partitions: input.partitions !== undefined ? [...input.partitions] : [],
    effects: input.effects !== undefined ? extractAST(input.effects) : undefined,
  });
}

/**
 * Extracts a string identifier from a `SourceASTNode<unknown>` when present, or returns `fallbackId`.
 *
 * Inspects `sourceNode.path`, `sourceNode.pathOrGlob`, and `sourceNode.id` in precedence order
 * so sourced scoped rules and skills inherit a deterministic diagnostic identifier.
 *
 * @param {SourceASTNode<unknown>} sourceNode                         - Source AST node to inspect.
 * @param {string}                 [fallbackId='sourced-scoped-rule'] - Fallback identifier when no path or id is present.
 *
 * @returns {string} Derived identifier string.
 */
export function resolveSourceRuleId(
  sourceNode: SourceASTNode<unknown>,
  fallbackId = 'sourced-scoped-rule',
): string {
  if ('path' in sourceNode && typeof sourceNode.path === 'string' && sourceNode.path.trim().length > 0) {
    return sourceNode.path;
  }
  if (
    'pathOrGlob' in sourceNode &&
    typeof sourceNode.pathOrGlob === 'string' &&
    sourceNode.pathOrGlob.trim().length > 0
  ) {
    return sourceNode.pathOrGlob;
  }
  if (typeof sourceNode.id === 'string' && sourceNode.id.trim().length > 0) {
    return sourceNode.id;
  }
  return fallbackId;
}

/**
 * Type guard checking whether a scoped rule argument is an `AstBuilder`.
 *
 * Distinguishes `ScopedRuleBuilder` and `AstBuilder<SourceASTNode<...>>` instances from
 * raw `ScopedRule` objects or `SourceASTNode` literals.
 *
 * @param {MaybeBuilder<ScopedRuleNode> | MaybeSource<ScopedRule | readonly ScopedRule[]>} entry - Candidate rule entry.
 *
 * @returns {entry is AstBuilder<ScopedRuleNode> | AstBuilder<SourceASTNode<ScopedRule | readonly ScopedRule[]>>} True when `entry` has a `.toAST()` method.
 */
export function hasToAstMethod(
  entry: MaybeBuilder<ScopedRuleNode> | MaybeSource<ScopedRule | readonly ScopedRule[]>,
): entry is AstBuilder<ScopedRuleNode> | AstBuilder<SourceASTNode<ScopedRule | readonly ScopedRule[]>> {
  return typeof entry === 'object' && entry !== null && 'toAST' in entry && typeof entry.toAST === 'function';
}
