import type {
  GlobalRule,
  LedgerStore,
  LessonStore,
  PostgresLedgerNode,
  PostgresLessonsNode,
  PostgresRulesSourceNode,
  PostgresTopologyNode,
  ResolutionContext,
  ResolvedSourceArtifact,
  RuntimeDriverContext,
  RuntimeExecutorRegistrySlice,
  TopologyStore,
} from '@harness-dsl/core';
import type { Pool } from 'pg';
import { resolvePostgresClient } from '../ddl/internal/resolve-postgres-client.js';
import type { PostgresPoolFactory } from '../ddl/postgres-pool-factory.js';
import type { PostgresQueryClient } from '../ddl/postgres-query-client.js';
import { PostgresLedgerStore } from '../stores/postgres-ledger-store.js';
import { PostgresLessonStore } from '../stores/postgres-lesson-store.js';
import { PostgresTopologyStore } from '../stores/postgres-topology-store.js';
import { executePostgresGlobalRulesSource } from './postgres-rules-source-executor.js';

/**
 * Creates a `RuntimeExecutorRegistrySlice` registering all `@harness-dsl/postgres` storage and source executors.
 *
 * Binds `'postgres:ledger'`, `'postgres:topology'`, `'postgres:lessons'`, and `'postgres:global-rules'`
 * with late-bound `ctx.resolveEnv(node.uri)` resolution against `poolOrClient` or `pg.Pool`.
 *
 * @param {PostgresPoolFactory | PostgresQueryClient | Pool} [poolOrClient] - Optional pool factory, query client, or `pg.Pool`.
 *
 * @returns {RuntimeExecutorRegistrySlice} Frozen executor registry slice for `@harness-dsl/postgres`.
 */
export function createPostgresExecutors(
  poolOrClient?: PostgresPoolFactory | PostgresQueryClient | Pool,
): RuntimeExecutorRegistrySlice {
  return Object.freeze<RuntimeExecutorRegistrySlice>({
    sources: Object.freeze({
      'postgres:global-rules': (
        node: PostgresRulesSourceNode,
        _input: void,
        ctx: ResolutionContext,
      ): Promise<ResolvedSourceArtifact<readonly GlobalRule[]>> =>
        executePostgresGlobalRulesSource(node, ctx, poolOrClient),
    }),
    ledgers: Object.freeze({
      'postgres:ledger': (node: PostgresLedgerNode, ctx: RuntimeDriverContext): LedgerStore => {
        const client = resolvePostgresClient(
          node.uri,
          (value) => ctx.resolveEnv(value),
          poolOrClient,
        );
        return new PostgresLedgerStore(client);
      },
    }),
    topologies: Object.freeze({
      'postgres:topology': (
        node: PostgresTopologyNode,
        ctx: RuntimeDriverContext,
      ): TopologyStore => {
        const client = resolvePostgresClient(
          node.uri,
          (value) => ctx.resolveEnv(value),
          poolOrClient,
        );
        return new PostgresTopologyStore(client);
      },
    }),
    lessons: Object.freeze({
      'postgres:lessons': (node: PostgresLessonsNode, ctx: RuntimeDriverContext): LessonStore => {
        const client = resolvePostgresClient(
          node.uri,
          (value) => ctx.resolveEnv(value),
          poolOrClient,
        );
        return new PostgresLessonStore(client);
      },
    }),
  });
}
