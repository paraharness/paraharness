import type { RuntimeExecutorRegistrySlice } from '@metaharness/core';
import { createFsExecutors } from './create-fs-executors.js';

/**
 * Default frozen `RuntimeExecutorRegistrySlice` instance for `@metaharness/fs`.
 *
 * Pass to `createExecutorRegistry(fsExecutors, ...)` to register all `@metaharness/fs`
 * sources, checks, policy guards, tripwires, telemetry collectors, effect matchers,
 * tool drivers, and lesson stores.
 */
export const fsExecutors: RuntimeExecutorRegistrySlice = createFsExecutors();
