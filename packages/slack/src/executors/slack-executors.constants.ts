import type { RuntimeExecutorRegistrySlice } from '@harness-dsl/core';
import { createSlackExecutors } from './create-slack-executors.js';
import { defaultSlackTransport } from './default-slack-transport.constants.js';

/** Default frozen `RuntimeExecutorRegistrySlice` for `@harness-dsl/slack`. */
export const slackExecutors: RuntimeExecutorRegistrySlice = createSlackExecutors(
  defaultSlackTransport,
);
