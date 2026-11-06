import type { RuntimeExecutorRegistrySlice } from '@harness-dsl/core';
import { createGithubExecutors } from './create-github-executors.js';
import { defaultGithubHttpTransport } from './default-github-http-transport.constants.js';

/** Default frozen `RuntimeExecutorRegistrySlice` for `@harness-dsl/github`. */
export const githubExecutors: RuntimeExecutorRegistrySlice = createGithubExecutors(
  defaultGithubHttpTransport,
);
