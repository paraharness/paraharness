import type { RuntimeExecutorRegistrySlice } from '@paraharness/core';
import { createSlackExecutors } from './create-slack-executors.js';
import { defaultSlackTransport } from './default-slack-transport.constants.js';

/** Default frozen `RuntimeExecutorRegistrySlice` for `@paraharness/slack`. */
export const slackExecutors: RuntimeExecutorRegistrySlice = createSlackExecutors(
  defaultSlackTransport,
);
