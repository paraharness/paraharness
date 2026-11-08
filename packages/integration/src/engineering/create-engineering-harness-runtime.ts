import {
  createRuntime,
  type HarnessRuntime,
  type HarnessRuntimeOptions,
} from '@metaharness/core';
import { createAllIntegrationExecutorsRegistry } from '../internal/create-all-integration-executors-registry.js';
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
  const registry = createAllIntegrationExecutorsRegistry(options?.registry);
  return createRuntime(appHarness, {
    registry,
    env: options?.env,
  });
}
