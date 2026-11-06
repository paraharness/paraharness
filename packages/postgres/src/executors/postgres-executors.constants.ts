import type { RuntimeExecutorRegistrySlice } from '@harness-dsl/core';
import { createPostgresExecutors } from './create-postgres-executors.js';

/**
 * Default frozen `RuntimeExecutorRegistrySlice` for `@harness-dsl/postgres`.
 *
 * Pre-registers `'postgres:ledger'`, `'postgres:topology'`, `'postgres:lessons'`, and `'postgres:global-rules'`;
 * use `createPostgresExecutors(poolFactory)` to inject a concrete `PostgresPoolFactory` or `PostgresQueryClient`.
 */
export const postgresExecutors: RuntimeExecutorRegistrySlice = createPostgresExecutors();
