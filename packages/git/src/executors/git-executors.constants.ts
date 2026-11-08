import type { RuntimeExecutorRegistrySlice } from '@paraharness/core';
import { createGitExecutors } from './create-git-executors.js';

/** Default frozen `RuntimeExecutorRegistrySlice` instance for `@paraharness/git`. */
export const gitExecutors: RuntimeExecutorRegistrySlice = createGitExecutors();
