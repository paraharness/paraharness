import type { RuntimeExecutorRegistrySlice } from '@harness-dsl/core';
import { createSqliteExecutors } from './create-sqlite-executors.js';

/**
 * Pre-built `RuntimeExecutorRegistrySlice` for `@harness-dsl/sqlite`.
 *
 * Registers `'sqlite:ledger'`, `'sqlite:topology'`, `'sqlite:lessons'`, and `'sqlite:global-rules'`
 * for composition into `createExecutorRegistry(sqliteExecutors, ...)`.
 */
export const sqliteExecutors: RuntimeExecutorRegistrySlice = createSqliteExecutors();
