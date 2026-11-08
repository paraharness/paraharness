import type { RuntimeExecutorRegistrySlice } from '@paraharness/core';
import {
  executeMarkdownFrontmatterSource,
  executeMarkdownSectionSource,
} from './markdown-source-executors.js';

/**
 * Creates the `@paraharness/markdown` runtime executor registry slice.
 *
 * Registers `'markdown:frontmatter'` and `'markdown:section'` source executors.
 *
 * @returns {RuntimeExecutorRegistrySlice} Frozen runtime executor registry slice for `@paraharness/markdown`.
 */
export function createMarkdownExecutors(): RuntimeExecutorRegistrySlice {
  return Object.freeze<RuntimeExecutorRegistrySlice>({
    sources: Object.freeze({
      'markdown:frontmatter': executeMarkdownFrontmatterSource,
      'markdown:section': executeMarkdownSectionSource,
    }),
  });
}
