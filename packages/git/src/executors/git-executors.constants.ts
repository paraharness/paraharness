import type { RuntimeExecutorRegistrySlice } from '@metaharness/core';
import { createGitExecutors } from './create-git-executors.js';

/** Default frozen `RuntimeExecutorRegistrySlice` instance for `@metaharness/git`. */
export const gitExecutors: RuntimeExecutorRegistrySlice = createGitExecutors();
