import { claudeExecutors } from '@paraharness/claude';
import {
  createExecutorRegistry,
  type RuntimeExecutorRegistry,
  type RuntimeExecutorRegistrySlice,
} from '@paraharness/core';
import { fsExecutors } from '@paraharness/fs';
import { geminiExecutors } from '@paraharness/gemini';
import { gitExecutors } from '@paraharness/git';
import { githubExecutors } from '@paraharness/github';
import { markdownExecutors } from '@paraharness/markdown';
import { netsuiteExecutors } from '@paraharness/netsuite';
import { nodeExecutors } from '@paraharness/node';
import { openaiExecutors } from '@paraharness/openai';
import { postgresExecutors } from '@paraharness/postgres';
import { slackExecutors } from '@paraharness/slack';
import { sqliteExecutors } from '@paraharness/sqlite';
import { stripeExecutors } from '@paraharness/stripe';

/**
 * Merges all 13 peer adapter `RuntimeExecutorRegistrySlice` maps with an optional caller override slice (`M4-integration.md` §4.1.3).
 *
 * Combines `sqliteExecutors`, `postgresExecutors`, `fsExecutors`, `markdownExecutors`, `nodeExecutors`,
 * `gitExecutors`, `claudeExecutors`, `openaiExecutors`, `geminiExecutors`, `githubExecutors`,
 * `slackExecutors`, `stripeExecutors`, and `netsuiteExecutors` so every AST node discriminant in
 * `appHarness` and `reconciliationFlow` resolves at runtime startup.
 *
 * @param {RuntimeExecutorRegistrySlice | readonly RuntimeExecutorRegistrySlice[]} [overrideRegistry] - Optional caller executor slice or slice array overrides merged last.
 *
 * @returns {RuntimeExecutorRegistry} Complete merged runtime executor registry.
 */
export function createAllIntegrationExecutorsRegistry(
  overrideRegistry?: RuntimeExecutorRegistrySlice | readonly RuntimeExecutorRegistrySlice[],
): RuntimeExecutorRegistry {
  if (overrideRegistry !== undefined) {
    const overrideSlices: readonly RuntimeExecutorRegistrySlice[] = Array.isArray(overrideRegistry)
      ? (overrideRegistry as readonly RuntimeExecutorRegistrySlice[])
      : [overrideRegistry as RuntimeExecutorRegistrySlice];
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
      ...overrideSlices,
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
