import type { RuntimeExecutorRegistrySlice } from '@metaharness/core';
import { createNetSuiteExecutors } from './create-netsuite-executors.js';

/**
 * Default frozen `RuntimeExecutorRegistrySlice` for `@metaharness/netsuite`.
 *
 * Registers `netsuite:draft-scope`, `netsuite:journal-tool`, `netsuite:closed-period-guard`,
 * `netsuite:balance-zero-check`, and `netsuite:rollback-abort-hook`.
 */
export const netsuiteExecutors: RuntimeExecutorRegistrySlice = createNetSuiteExecutors();
