import type { RuntimeExecutorRegistrySlice } from '@harness-dsl/core';
import {
  executeMarkdownFrontmatterSource,
  executeMarkdownSectionSource,
} from './markdown-source-executors.js';

/**
 * Creates the `@harness-dsl/markdown` runtime executor registry slice.
 *
 * Registers `'markdown:frontmatter'` and `'markdown:section'` source executors.
 *
 * @returns {RuntimeExecutorRegistrySlice} Frozen runtime executor registry slice for `@harness-dsl/markdown`.
 */
export function createMarkdownExecutors(): RuntimeExecutorRegistrySlice {
  return Object.freeze<RuntimeExecutorRegistrySlice>({
    sources: Object.freeze({
      'markdown:frontmatter': executeMarkdownFrontmatterSource,
      'markdown:section': executeMarkdownSectionSource,
    }),
  });
}
