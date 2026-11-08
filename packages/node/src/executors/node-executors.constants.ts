import type { RuntimeExecutorRegistrySlice } from '@paraharness/core';
import { createNodeExecutors } from './create-node-executors.js';

/** Default frozen `RuntimeExecutorRegistrySlice` instance for `@paraharness/node`. */
export const nodeExecutors: RuntimeExecutorRegistrySlice = createNodeExecutors();
