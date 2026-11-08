import type { RuntimeExecutorRegistrySlice } from '@metaharness/core';
import { createSqliteExecutors } from './create-sqlite-executors.js';

/**
 * Pre-built `RuntimeExecutorRegistrySlice` for `@metaharness/sqlite`.
 *
 * Registers `'sqlite:ledger'`, `'sqlite:topology'`, `'sqlite:lessons'`, and `'sqlite:global-rules'`
 * for composition into `createExecutorRegistry(sqliteExecutors, ...)`.
 */
export const sqliteExecutors: RuntimeExecutorRegistrySlice = createSqliteExecutors();
