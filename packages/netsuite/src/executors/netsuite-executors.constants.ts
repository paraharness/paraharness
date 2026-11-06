import type { RuntimeExecutorRegistrySlice } from '@harness-dsl/core';
import { createNetSuiteExecutors } from './create-netsuite-executors.js';

/**
 * Default frozen `RuntimeExecutorRegistrySlice` for `@harness-dsl/netsuite`.
 *
 * Registers `netsuite:draft-scope`, `netsuite:journal-tool`, `netsuite:closed-period-guard`,
 * `netsuite:balance-zero-check`, and `netsuite:rollback-abort-hook`.
 */
export const netsuiteExecutors: RuntimeExecutorRegistrySlice = createNetSuiteExecutors();
