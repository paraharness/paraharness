import { isSliceArray, mergeCategory } from './internal/merge-executor-registry-category.js';
import type { RuntimeExecutorRegistry } from './runtime-executor-registry.js';
import type { RuntimeExecutorRegistrySlice } from './runtime-executor-registry-slice.js';

/**
 * Merges one or more `RuntimeExecutorRegistrySlice` objects (or nested arrays of slices) into a frozen `RuntimeExecutorRegistry`.
 *
 * Initializes all 22 executor and driver lookup categories and copies each slice's registered node
 * handlers in argument order so later slices override earlier slices when the same `node.type` key is provided.
 *
 * @param {...ReadonlyArray<RuntimeExecutorRegistrySlice | readonly RuntimeExecutorRegistrySlice[]>} slices - Adapter registry slices or arrays of slices to merge.
 *
 * @returns {RuntimeExecutorRegistry} Deeply frozen composite `RuntimeExecutorRegistry` instance.
 */
export function createExecutorRegistry(
  ...slices: ReadonlyArray<RuntimeExecutorRegistrySlice | readonly RuntimeExecutorRegistrySlice[]>
): RuntimeExecutorRegistry {
  const flatSlices: RuntimeExecutorRegistrySlice[] = [];
  for (const entry of slices) {
    if (isSliceArray(entry)) {
      for (const nested of entry) {
        flatSlices.push(nested);
      }
    } else {
      flatSlices.push(entry);
    }
  }

  return Object.freeze<RuntimeExecutorRegistry>({
    steps: mergeCategory(flatSlices, 'steps'),
    sources: mergeCategory(flatSlices, 'sources'),
    checks: mergeCategory(flatSlices, 'checks'),
    abortHooks: mergeCategory(flatSlices, 'abortHooks'),
    rewindHooks: mergeCategory(flatSlices, 'rewindHooks'),
    crossVerifiers: mergeCategory(flatSlices, 'crossVerifiers'),
    services: mergeCategory(flatSlices, 'services'),
    policyGuards: mergeCategory(flatSlices, 'policyGuards'),
    quotaTripwires: mergeCategory(flatSlices, 'quotaTripwires'),
    telemetryCollectors: mergeCategory(flatSlices, 'telemetryCollectors'),
    effectMatchers: mergeCategory(flatSlices, 'effectMatchers'),
    tools: mergeCategory(flatSlices, 'tools'),
    runners: mergeCategory(flatSlices, 'runners'),
    scopes: mergeCategory(flatSlices, 'scopes'),
    models: mergeCategory(flatSlices, 'models'),
    ledgers: mergeCategory(flatSlices, 'ledgers'),
    topologies: mergeCategory(flatSlices, 'topologies'),
    lessons: mergeCategory(flatSlices, 'lessons'),
    trackers: mergeCategory(flatSlices, 'trackers'),
    streamSources: mergeCategory(flatSlices, 'streamSources'),
    humanChannels: mergeCategory(flatSlices, 'humanChannels'),
    controlPlanes: mergeCategory(flatSlices, 'controlPlanes'),
  });
}
