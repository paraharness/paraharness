import type { RuntimeExecutorRegistrySlice } from '@paraharness/core';
import { createGithubExecutors } from './create-github-executors.js';
import { defaultGithubHttpTransport } from './default-github-http-transport.constants.js';

/** Default frozen `RuntimeExecutorRegistrySlice` for `@paraharness/github`. */
export const githubExecutors: RuntimeExecutorRegistrySlice = createGithubExecutors(
  defaultGithubHttpTransport,
);
