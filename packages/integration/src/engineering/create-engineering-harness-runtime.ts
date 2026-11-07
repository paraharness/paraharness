import { claudeExecutors } from '@harness-dsl/claude';
import {
  createExecutorRegistry,
  createRuntime,
  type HarnessRuntime,
  type HarnessRuntimeOptions,
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
import { appHarness } from './engineering-lane-and-harness.constants.js';

/**
 * Instantiates a `HarnessRuntime` for `appHarness` wired with all 13 peer adapter executor slices (`M4-integration.md` §4.1.3).
 *
 * Merges `sqliteExecutors`, `postgresExecutors`, `fsExecutors`, `markdownExecutors`, `nodeExecutors`,
 * `gitExecutors`, `claudeExecutors`, `openaiExecutors`, `geminiExecutors`, `githubExecutors`,
 * `slackExecutors`, `stripeExecutors`, and `netsuiteExecutors` (plus any caller-supplied `options.registry`
 * overrides) and binds `appHarness` without import-time side effects.
 *
 * @param {HarnessRuntimeOptions} [options] - Optional executor registry overrides and environment variable map.
 *
 * @returns {HarnessRuntime} Configured `HarnessRuntime` instance ready for `.start()` and `.stop()`.
 */
export function createEngineeringHarnessRuntime(
  options?: HarnessRuntimeOptions,
): HarnessRuntime {
  const defaultSlices = [
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
  ];
  const registry =
    options?.registry !== undefined
      ? createExecutorRegistry(defaultSlices, options.registry)
      : createExecutorRegistry(defaultSlices);

  return createRuntime(appHarness, {
    registry,
    env: options?.env,
  });
}
