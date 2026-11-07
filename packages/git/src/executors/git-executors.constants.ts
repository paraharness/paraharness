import type { RuntimeExecutorRegistrySlice } from '@harness-dsl/core';
import { createGitExecutors } from './create-git-executors.js';

/** Default frozen `RuntimeExecutorRegistrySlice` instance for `@harness-dsl/git`. */
export const gitExecutors: RuntimeExecutorRegistrySlice = createGitExecutors();
