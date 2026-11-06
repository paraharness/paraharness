/**
 * Base contract for all passive, JSON-serializable Abstract Syntax Tree (AST) nodes.
 *
 * Every construct across `@harness-dsl/core` and peer domain adapter packages compiles into
 * an immutable plain object discriminated by a string-literal `type` property with zero execution methods.
 */
export interface ASTNode {
  /** Unique string-literal discriminant identifying the node kind. */
  readonly type: string;
}
