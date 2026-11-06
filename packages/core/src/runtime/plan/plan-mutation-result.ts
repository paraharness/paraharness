/**
 * Outcome returned by `executeSpawnTasks()` or `executeAddDependencies()`.
 *
 * Indicates the chained prerequisite keys, updated `previousSpawnedTipKey`, and whether the parent step suspended.
 */
export interface PlanMutationResult {
  /** Ordered work item keys of the spawned or linked prerequisites. */
  readonly prerequisiteItemKeys: readonly string[];
  /** Tip item key of the linear prerequisite chain ($T_k$). */
  readonly latestTipItemKey: string | undefined;
  /** True when the parent step transitioned to `'SUSPENDED'` (`onPrerequisiteSpawned: 'suspend-and-yield-slot'`). */
  readonly suspended: boolean;
  /** Optional `headScopeCheckpoint` captured prior to yielding the concurrency slot. */
  readonly headScopeCheckpoint?: string;
  /** Serialized tool result string to record in `completedResults`. */
  readonly toolResultText: string;
}
