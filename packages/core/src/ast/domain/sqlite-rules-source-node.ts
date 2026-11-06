import type { BaseSourceASTNode } from '../base/base-source-ast-node.js';

/**
 * Passive AST node loading global rules from a SQLite table (`sqlite.globalRules`).
 *
 * Queries ordered `(id, directive)` rows from `table` in the SQLite database at `uri` when
 * compiling prefix groups or Turn-0 rule context.
 */
export interface SqliteRulesSourceNode
  extends BaseSourceASTNode<
    'sqlite:global-rules',
    ReadonlyArray<{ readonly id: string; readonly directive: string }>
  > {
  /** Host-root-relative SQLite database file path or `:memory:` URI. */
  readonly uri: string;
  /** Relational table name storing `(id, directive)` rows. */
  readonly table: string;
}
