import type { RuntimeExecutorRegistrySlice } from '@paraharness/core';
import { createOpenAiExecutors } from './create-openai-executors.js';

/** Default `RuntimeExecutorRegistrySlice` for `@paraharness/openai` (`models['openai:model']`). */
export const openaiExecutors: RuntimeExecutorRegistrySlice = createOpenAiExecutors();
