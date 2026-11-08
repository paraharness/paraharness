import type { RuntimeExecutorRegistrySlice } from '@metaharness/core';
import { createOpenAiExecutors } from './create-openai-executors.js';

/** Default `RuntimeExecutorRegistrySlice` for `@metaharness/openai` (`models['openai:model']`). */
export const openaiExecutors: RuntimeExecutorRegistrySlice = createOpenAiExecutors();
