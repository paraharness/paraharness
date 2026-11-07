import type { TrackerAdapter } from '../../../ports/tracker-adapter.js';
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
  const factory = node !== undefined ? cfg.registry.trackers[node.type] : undefined;
  if (factory === undefined || node === undefined) {
    return undefined;
  }
  return factory(node as never, {
    registry: cfg.registry,
    resolveEnv: (v) => (typeof v === 'string' ? v : cfg.env[v.key]),
    getRunner: (n) => {
      const runnerFactory = cfg.registry.runners[n.type];
      if (runnerFactory === undefined) {
        throw new Error(
          `No RunnerDriver registered for '${n.type}' (runner id '${n.id}', lane '${cfg.lane.id}').`,
        );
      }
      return runnerFactory(n as never);
    },
  });
}
