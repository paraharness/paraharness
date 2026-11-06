import type { RuntimeExecutorRegistrySlice } from '@harness-dsl/core';
import { createOpenAiExecutors } from './create-openai-executors.js';

/** Default `RuntimeExecutorRegistrySlice` for `@harness-dsl/openai` (`models['openai:model']`). */
export const openaiExecutors: RuntimeExecutorRegistrySlice = createOpenAiExecutors();
