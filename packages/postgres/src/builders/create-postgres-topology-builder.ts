import type { EnvRef, PostgresTopologyNode } from '@harness-dsl/core';
import type { PostgresTopologyBuilder } from './postgres-topology-builder.js';

/**
 * Creates a pure, side-effect-free `PostgresTopologyBuilder` for `postgres.topologyStore(uri)`.
 *
 * Produces an immutable builder whose `.toAST()` method returns a frozen `PostgresTopologyNode`
 * carrying the supplied connection URI or symbolic `EnvRef`.
 *
 * @param {string | EnvRef} uri - PostgreSQL connection URI or symbolic `H.env(...)` reference.
 *
 * @returns {PostgresTopologyBuilder} Immutable builder for `PostgresTopologyNode`.
 */
export function createPostgresTopologyBuilder(uri: string | EnvRef): PostgresTopologyBuilder {
  return Object.freeze<PostgresTopologyBuilder>({
    toAST(): PostgresTopologyNode {
      return Object.freeze<PostgresTopologyNode>({
        type: 'postgres:topology',
        uri,
      });
    },
  });
}
