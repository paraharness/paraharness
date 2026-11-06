import type { BaseSourceASTNode } from '../base/base-source-ast-node.js';
import type { EnvRef } from '../env-ref.js';

/**
 * Passive AST node loading global rules from a PostgreSQL table (`postgres.globalRules`).
 *
 * Queries ordered `(id, directive)` rows from `table` in the PostgreSQL database at `uri` when
 * compiling prefix groups or Turn-0 rule context.
 */
export interface PostgresRulesSourceNode
  extends BaseSourceASTNode<
    'postgres:global-rules',
    ReadonlyArray<{ readonly id: string; readonly directive: string }>
  > {
  /** PostgreSQL connection URI or symbolic `EnvRef`. */
  readonly uri: string | EnvRef;
  /** Relational table name storing `(id, directive)` rows. */
  readonly table: string;
}
