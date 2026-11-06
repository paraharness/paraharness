import type { BaseTopologyStoreASTNode } from '../base/base-topology-store-ast-node.js';
import type { EnvRef } from '../env-ref.js';

/**
 * Passive AST node configuring a PostgreSQL topology store (`postgres.topologyStore`).
 *
 * Stores base partition contract markdown/epochs alongside Copy-on-Write per-run overlays
 * inside a transactional PostgreSQL database.
 */
export interface PostgresTopologyNode extends BaseTopologyStoreASTNode<'postgres:topology'> {
  /** PostgreSQL connection URI or symbolic `EnvRef`. */
  readonly uri: string | EnvRef;
}
