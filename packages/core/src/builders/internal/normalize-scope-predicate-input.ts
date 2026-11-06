import type { MaybeBuilder, MaybeSource } from '../../ast/ast-foundation.types.js';
import type { AstBuilder } from '../../ast/ast-builder.js';
import type { SourceASTNode } from '../../ast/domain-ast.types.js';
import { extractAST } from '../../ast/extract-ast.js';
import type { ScopedRuleNode } from '../../ast/scoped-rule-node.js';
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
 * Extracts a string identifier from a `SourceASTNode<ScopedRule>` when present, or returns `'sourced-scoped-rule'`.
 *
 * Inspects `sourceNode.path` when available so sourced scoped rules inherit a deterministic
 * diagnostic identifier.
 *
 * @param {SourceASTNode<ScopedRule>} sourceNode - Source AST node to inspect.
 *
 * @returns {string} Derived identifier string.
 */
export function resolveSourceRuleId(sourceNode: SourceASTNode<ScopedRule>): string {
  if ('path' in sourceNode && typeof sourceNode.path === 'string') {
    return sourceNode.path;
  }
  return 'sourced-scoped-rule';
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
