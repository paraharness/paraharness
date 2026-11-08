import type { RuntimeExecutorRegistrySlice } from '@metaharness/core';
import { createNodeExecutors } from './create-node-executors.js';

/** Default frozen `RuntimeExecutorRegistrySlice` instance for `@metaharness/node`. */
export const nodeExecutors: RuntimeExecutorRegistrySlice = createNodeExecutors();
