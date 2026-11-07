import {
  createRuntime,
  H,
  type HarnessRuntime,
  type HarnessRuntimeOptions,
} from '@harness-dsl/core';
import { sqlite } from '@harness-dsl/sqlite';
import { createAllIntegrationExecutorsRegistry } from '../internal/create-all-integration-executors-registry.js';
import { reconciliationFlow } from './reconciliation-harness.constants.js';
import { discrepancyItem } from './reconciliation-schemas.schema.js';

/**
 * Instantiates a `HarnessRuntime` hosting `reconciliationFlow` wired with all 13 peer adapter executor slices (`M4-integration.md` §4.1.3).
 *
 * Wraps `reconciliationFlow` inside a dedicated financial harness and lane backed by `sqlite.ledger` and
 * merges all 13 adapter executor slices (plus any caller-supplied `options.registry` overrides).
 *
 * @param {HarnessRuntimeOptions} [options] - Optional executor registry overrides and environment variable map.
 *
 * @returns {HarnessRuntime} Configured `HarnessRuntime` instance for the financial reconciliation harness.
 */
export function createReconciliationHarnessRuntime(
  options?: HarnessRuntimeOptions,
): HarnessRuntime {
  const registry = createAllIntegrationExecutorsRegistry(options?.registry);
  const ledgerUri = options?.env?.['RECONCILIATION_LEDGER_PATH'] ?? ':memory:';
  const reconciliationLane = H.lane('reconciliation-lane')
    .input(discrepancyItem)
    .key((item) => item.discrepancyId)
    .flow(reconciliationFlow);
  const reconciliationHarness = H.harness('reconciliation-harness')
    .ledger(sqlite.ledger(ledgerUri))
    .lanes(reconciliationLane);

  return createRuntime(reconciliationHarness, {
    registry,
    env: options?.env,
  });
}
