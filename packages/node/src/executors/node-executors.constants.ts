import type { RuntimeExecutorRegistrySlice } from '@harness-dsl/core';
import { createNodeExecutors } from './create-node-executors.js';

/** Default frozen `RuntimeExecutorRegistrySlice` instance for `@harness-dsl/node`. */
export const nodeExecutors: RuntimeExecutorRegistrySlice = createNodeExecutors();
