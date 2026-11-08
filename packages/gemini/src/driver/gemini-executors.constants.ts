import type { RuntimeExecutorRegistrySlice } from '@metaharness/core';
import { createGeminiExecutors } from './create-gemini-executors.js';

/** Default `RuntimeExecutorRegistrySlice` for `@metaharness/gemini` (`models['gemini:model']`). */
export const geminiExecutors: RuntimeExecutorRegistrySlice = createGeminiExecutors();
