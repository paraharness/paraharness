import type { RuntimeExecutorRegistrySlice } from '@metaharness/core';
import { createSlackExecutors } from './create-slack-executors.js';
import { defaultSlackTransport } from './default-slack-transport.constants.js';

/** Default frozen `RuntimeExecutorRegistrySlice` for `@metaharness/slack`. */
export const slackExecutors: RuntimeExecutorRegistrySlice = createSlackExecutors(
  defaultSlackTransport,
);
