import type { RuntimeExecutorRegistrySlice } from '@metaharness/core';
import { createGithubExecutors } from './create-github-executors.js';
import { defaultGithubHttpTransport } from './default-github-http-transport.constants.js';

/** Default frozen `RuntimeExecutorRegistrySlice` for `@metaharness/github`. */
export const githubExecutors: RuntimeExecutorRegistrySlice = createGithubExecutors(
  defaultGithubHttpTransport,
);
