import type { RuntimeExecutorRegistrySlice } from '@paraharness/core';
import { createClaudeExecutors } from './create-claude-executors.js';

/** Default `RuntimeExecutorRegistrySlice` for `@paraharness/claude` (`models['claude:model']`). */
export const claudeExecutors: RuntimeExecutorRegistrySlice = createClaudeExecutors();
