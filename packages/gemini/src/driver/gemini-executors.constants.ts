import type { RuntimeExecutorRegistrySlice } from '@paraharness/core';
import { createGeminiExecutors } from './create-gemini-executors.js';

/** Default `RuntimeExecutorRegistrySlice` for `@paraharness/gemini` (`models['gemini:model']`). */
export const geminiExecutors: RuntimeExecutorRegistrySlice = createGeminiExecutors();
