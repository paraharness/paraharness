import type { EnvRef, PostgresTopologyNode } from '@paraharness/core';
import type { PostgresTopologyBuilder } from './postgres-topology-builder.js';

/**
 * Creates a pure, side-effect-free `PostgresTopologyBuilder` for `postgres.topologyStore(uri)`.
 *
 * Produces an immutable builder whose `.toAST()` method returns a frozen `PostgresTopologyNode`
 * carrying the supplied connection URI or symbolic `EnvRef`.
 *
 * @param {string | EnvRef} uri - PostgreSQL connection URI or symbolic `P.env(...)` reference.
 *
 * @returns {PostgresTopologyBuilder} Immutable builder for `PostgresTopologyNode`.
 */
export function createPostgresTopologyBuilder(uri: string | EnvRef): PostgresTopologyBuilder {
  if (typeof uri === 'string' && uri.trim().length === 0) {
    throw new Error('postgres.topologyStore(uri) requires a non-empty database URI.');
  }
  return Object.freeze<PostgresTopologyBuilder>({
    toAST(): PostgresTopologyNode {
      return Object.freeze<PostgresTopologyNode>({
        type: 'postgres:topology',
        uri,
      });
    },
  });
}
