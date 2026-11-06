/**
 * Numeric scheduling priority weights assigned to each `LaneNode.priority` level (`SPEC.md` §3.10).
 *
 * Maps `'low'` (`10`), `'normal'` (`20`), `'high'` (`30`), and `'critical'` (`40`) to base weights
 * before applying aging increments or parent priority boost inheritance.
 */
export const LANE_PRIORITY_WEIGHTS: Readonly<
  Record<'low' | 'normal' | 'high' | 'critical', number>
> = Object.freeze({
  low: 10,
  normal: 20,
  high: 30,
  critical: 40,
});

/**
 * Default priority aging interval in milliseconds (`60,000` ms = 1 minute) when `agingMinutes` is evaluated (`SPEC.md` §3.10).
 *
 * Used to convert elapsed queue wait time into discrete aging intervals.
 */
export const DEFAULT_PRIORITY_AGING_INTERVAL_MS = 60_000;

/**
 * Priority weight increment (`5`) added per elapsed aging interval (`SPEC.md` §3.10).
 *
 * Ensures lower-priority items waiting in a lane eventually overtake newly arrived higher-priority items.
 */
export const PRIORITY_AGING_STEP_WEIGHT = 5;

/**
 * Default maximum age in hours (`168` hours) for `SEALED_UNMERGED` topology overlays before eviction (`SPEC.md` §3.3).
 *
 * Used by background topology GC sweeps when no explicit `maxSealedAgeHours` is specified.
 */
export const DEFAULT_MAX_SEALED_AGE_HOURS = 168;
