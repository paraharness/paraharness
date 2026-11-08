import { claudeExecutors } from '@metaharness/claude';
import {
  createExecutorRegistry,
  type RuntimeExecutorRegistry,
  type RuntimeExecutorRegistrySlice,
} from '@metaharness/core';
import { fsExecutors } from '@metaharness/fs';
import { geminiExecutors } from '@metaharness/gemini';
import { gitExecutors } from '@metaharness/git';
import { githubExecutors } from '@metaharness/github';
import { markdownExecutors } from '@metaharness/markdown';
import { netsuiteExecutors } from '@metaharness/netsuite';
import { nodeExecutors } from '@metaharness/node';
import { openaiExecutors } from '@metaharness/openai';
import { postgresExecutors } from '@metaharness/postgres';
import { slackExecutors } from '@metaharness/slack';
import { sqliteExecutors } from '@metaharness/sqlite';
import { stripeExecutors } from '@metaharness/stripe';

/**
 * Merges all 13 peer adapter `RuntimeExecutorRegistrySlice` maps with an optional caller override slice (`M4-integration.md` §4.1.3).
 *
 * Combines `sqliteExecutors`, `postgresExecutors`, `fsExecutors`, `markdownExecutors`, `nodeExecutors`,
 * `gitExecutors`, `claudeExecutors`, `openaiExecutors`, `geminiExecutors`, `githubExecutors`,
 * `slackExecutors`, `stripeExecutors`, and `netsuiteExecutors` so every AST node discriminant in
 * `appHarness` and `reconciliationFlow` resolves at runtime startup.
 *
 * @param {RuntimeExecutorRegistrySlice} [overrideRegistry] - Optional caller executor slice overrides merged last.
 *
 * @returns {RuntimeExecutorRegistry} Complete merged runtime executor registry.
 */
export function createAllIntegrationExecutorsRegistry(
  overrideRegistry?: RuntimeExecutorRegistrySlice,
): RuntimeExecutorRegistry {
  if (overrideRegistry !== undefined) {
    return createExecutorRegistry(
      sqliteExecutors,
      postgresExecutors,
      fsExecutors,
      markdownExecutors,
      nodeExecutors,
      gitExecutors,
      claudeExecutors,
      openaiExecutors,
      geminiExecutors,
      githubExecutors,
      slackExecutors,
      stripeExecutors,
      netsuiteExecutors,
      overrideRegistry,
    );
  }
  return createExecutorRegistry(
    sqliteExecutors,
    postgresExecutors,
    fsExecutors,
    markdownExecutors,
    nodeExecutors,
    gitExecutors,
    claudeExecutors,
    openaiExecutors,
    geminiExecutors,
    githubExecutors,
    slackExecutors,
    stripeExecutors,
    netsuiteExecutors,
  );
}
