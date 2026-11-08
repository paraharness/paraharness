import type { RuntimeExecutorRegistrySlice } from '@paraharness/core';
import { createFsExecutors } from './create-fs-executors.js';

/**
 * Default frozen `RuntimeExecutorRegistrySlice` instance for `@paraharness/fs`.
 *
 * Pass to `createExecutorRegistry(fsExecutors, ...)` to register all `@paraharness/fs`
 * sources, checks, policy guards, tripwires, telemetry collectors, effect matchers,
 * tool drivers, and lesson stores.
 */
export const fsExecutors: RuntimeExecutorRegistrySlice = createFsExecutors();
