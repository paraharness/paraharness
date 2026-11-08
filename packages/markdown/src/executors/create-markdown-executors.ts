import type { RuntimeExecutorRegistrySlice } from '@metaharness/core';
import {
  executeMarkdownFrontmatterSource,
  executeMarkdownSectionSource,
} from './markdown-source-executors.js';

/**
 * Creates the `@metaharness/markdown` runtime executor registry slice.
 *
 * Registers `'markdown:frontmatter'` and `'markdown:section'` source executors.
 *
 * @returns {RuntimeExecutorRegistrySlice} Frozen runtime executor registry slice for `@metaharness/markdown`.
 */
export function createMarkdownExecutors(): RuntimeExecutorRegistrySlice {
  return Object.freeze<RuntimeExecutorRegistrySlice>({
    sources: Object.freeze({
      'markdown:frontmatter': executeMarkdownFrontmatterSource,
      'markdown:section': executeMarkdownSectionSource,
    }),
  });
}
