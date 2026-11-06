import type { RuntimeExecutorRegistrySlice } from '@harness-dsl/core';
import { createMarkdownExecutors } from './create-markdown-executors.js';

/**
 * Default frozen `@harness-dsl/markdown` runtime executor registry slice (`markdownExecutors`).
 *
 * Ready to pass directly to `createRuntime({ executors: [markdownExecutors, ...] })`.
 */
export const markdownExecutors: RuntimeExecutorRegistrySlice = createMarkdownExecutors();
