import type { BaseTopologyStoreASTNode } from '../base/base-topology-store-ast-node.js';

/**
 * Passive AST node configuring a WAL-mode SQLite topology store (`sqlite.topologyStore`).
 *
 * Stores base partition contract markdown/epochs alongside Copy-on-Write per-run overlays
 * inside a local SQLite database.
 */
export interface SqliteTopologyNode extends BaseTopologyStoreASTNode<'sqlite:topology'> {
  /** Host-root-relative SQLite database file path or `:memory:` URI. */
  readonly uri: string;
}
