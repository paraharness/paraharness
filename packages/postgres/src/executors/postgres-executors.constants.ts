import type { RuntimeExecutorRegistrySlice } from '@paraharness/core';
import { createPostgresExecutors } from './create-postgres-executors.js';

/**
 * Default frozen `RuntimeExecutorRegistrySlice` for `@paraharness/postgres`.
 *
 * Pre-registers `'postgres:ledger'`, `'postgres:topology'`, `'postgres:lessons'`, and `'postgres:global-rules'`;
 * use `createPostgresExecutors(poolFactory)` to inject a concrete `PostgresPoolFactory` or `PostgresQueryClient`.
 */
export const postgresExecutors: RuntimeExecutorRegistrySlice = createPostgresExecutors();
