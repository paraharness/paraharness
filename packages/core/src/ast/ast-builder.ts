import type { ASTNode } from './ast-node.js';

/**
 * Fluent builder contract that compiles declarative configuration into a passive AST node.
 *
 * Builders are copy-on-write immutable and remain separate from the passive AST records
 * they emit via `toAST()`.
 *
 * @template TNode Passive AST node type produced by this builder.
 */
export interface AstBuilder<TNode extends ASTNode = ASTNode> {
  /**
   * Compiles the current builder configuration into a deeply frozen passive AST node.
   *
   * Validates required builder invariants at compilation time and returns an immutable
   * plain-object AST representation containing zero execution methods.
   *
   * @returns {TNode} Deeply frozen passive AST node.
   */
  toAST(): TNode;
}
