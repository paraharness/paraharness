import { claudeExecutors } from '@harness-dsl/claude';
import {
  createExecutorRegistry,
  type RuntimeExecutorRegistry,
  type RuntimeExecutorRegistrySlice,
} from '@harness-dsl/core';
import { fsExecutors } from '@harness-dsl/fs';
import { geminiExecutors } from '@harness-dsl/gemini';
import { gitExecutors } from '@harness-dsl/git';
import { githubExecutors } from '@harness-dsl/github';
import { markdownExecutors } from '@harness-dsl/markdown';
import { netsuiteExecutors } from '@harness-dsl/netsuite';
import { nodeExecutors } from '@harness-dsl/node';
import { openaiExecutors } from '@harness-dsl/openai';
import { postgresExecutors } from '@harness-dsl/postgres';
import { slackExecutors } from '@harness-dsl/slack';
import { sqliteExecutors } from '@harness-dsl/sqlite';
import { stripeExecutors } from '@harness-dsl/stripe';

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
