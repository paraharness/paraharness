import type { RuntimeExecutorRegistrySlice } from '@harness-dsl/core';
import { createFsExecutors } from './create-fs-executors.js';

/**
 * Default frozen `RuntimeExecutorRegistrySlice` instance for `@harness-dsl/fs`.
 *
 * Pass to `createExecutorRegistry(fsExecutors, ...)` to register all `@harness-dsl/fs`
 * sources, checks, policy guards, tripwires, telemetry collectors, effect matchers,
 * tool drivers, and lesson stores.
 */
export const fsExecutors: RuntimeExecutorRegistrySlice = createFsExecutors();
