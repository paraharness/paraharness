import type { RuntimeExecutorRegistrySlice } from '@harness-dsl/core';
import { createClaudeExecutors } from './create-claude-executors.js';

/** Default `RuntimeExecutorRegistrySlice` for `@harness-dsl/claude` (`models['claude:model']`). */
export const claudeExecutors: RuntimeExecutorRegistrySlice = createClaudeExecutors();
