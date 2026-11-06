import type { RuntimeExecutorRegistrySlice } from '@harness-dsl/core';
import { createGeminiExecutors } from './create-gemini-executors.js';

/** Default `RuntimeExecutorRegistrySlice` for `@harness-dsl/gemini` (`models['gemini:model']`). */
export const geminiExecutors: RuntimeExecutorRegistrySlice = createGeminiExecutors();
