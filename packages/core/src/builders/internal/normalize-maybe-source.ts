import type { MaybeSource, SourceValue } from '../../ast/ast-foundation.types.js';
import type { SourceASTNode } from '../../ast/domain-ast.types.js';

/**
 * Normalizes a `MaybeSource<T>` value into a passive `SourceValue<T>` (`T | SourceASTNode<T>`).
 *
 * Invokes `.toAST()` when `input` is an `AstBuilder<SourceASTNode<T>>` and returns inline
 * values or pre-compiled `SourceASTNode<T>` records unchanged.
 *
 * @template T Resolved content type produced by the source.
 *
 * @param {MaybeSource<T>} input - Inline value, compiled `SourceASTNode<T>`, or `AstBuilder<SourceASTNode<T>>`.
 *
 * @returns {SourceValue<T>} Normalized passive `SourceValue<T>`.
 */
export function normalizeMaybeSource<T>(input: MaybeSource<T>): SourceValue<T> {
  if (
    typeof input === 'object' &&
    input !== null &&
    'toAST' in input &&
    typeof input.toAST === 'function'
  ) {
    return input.toAST();
  }
  return input as T | SourceASTNode<T>;
}
