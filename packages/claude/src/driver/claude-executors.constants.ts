import type { RuntimeExecutorRegistrySlice } from '@metaharness/core';
import { createClaudeExecutors } from './create-claude-executors.js';

/** Default `RuntimeExecutorRegistrySlice` for `@metaharness/claude` (`models['claude:model']`). */
export const claudeExecutors: RuntimeExecutorRegistrySlice = createClaudeExecutors();
