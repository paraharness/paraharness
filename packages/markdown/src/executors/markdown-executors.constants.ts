import type { RuntimeExecutorRegistrySlice } from '@paraharness/core';
import { createMarkdownExecutors } from './create-markdown-executors.js';

/**
 * Default frozen `@paraharness/markdown` runtime executor registry slice (`markdownExecutors`).
 *
 * Ready to pass directly to `createRuntime({ executors: [markdownExecutors, ...] })`.
 */
export const markdownExecutors: RuntimeExecutorRegistrySlice = createMarkdownExecutors();
