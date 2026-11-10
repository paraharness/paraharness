import type { TrackerAdapter } from '../../../ports/tracker-adapter.js';
import { createMemoizedRunnerResolver } from '../../pools/internal/create-memoized-runner-resolver.js';
import type { LaneSchedulerConfig } from '../lane-scheduler-config.js';

/**
 * Resolves the runtime `TrackerAdapter` for `cfg.lane.tracker` from `cfg.trackerAdapter` or `cfg.registry.trackers`.
 *
 * Returns `undefined` when no tracker is configured on the lane or registered in the executor registry.
 *
 * @template TIn Validated lane work item input type.
 *
 * @param {LaneSchedulerConfig<TIn>} cfg - Lane scheduler configuration and stores.
 *
 * @returns {TrackerAdapter<unknown, string> | undefined} Resolved tracker adapter, or `undefined`.
 */
export function resolveLaneTrackerAdapter<TIn = unknown>(
  cfg: LaneSchedulerConfig<TIn>,
): TrackerAdapter<unknown, string> | undefined {
  if (cfg.trackerAdapter !== undefined) {
    return cfg.trackerAdapter;
  }
  const node = cfg.lane.tracker?.adapter;
  if (node === undefined) {
    return undefined;
  }
  const factory = cfg.registry.trackers[node.type];
  if (factory === undefined) {
    throw new Error(
      `No TrackerAdapter registered for '${node.type}' on lane '${cfg.lane.id}' (registered trackers: [${Object.keys(cfg.registry.trackers).join(', ')}]).`,
    );
  }
  return factory(node as never, {
    registry: cfg.registry,
    resolveEnv: (v) => (typeof v === 'string' ? v : cfg.env[v.key]),
    getRunner: createMemoizedRunnerResolver(cfg.registry, `lane '${cfg.lane.id}'`),
  });
}
