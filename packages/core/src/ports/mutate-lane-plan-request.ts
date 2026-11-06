/**
 * Newly spawned work item entry inside a `MutateLanePlanRequest`.
 *
 * Specifies the deduplication item key, serialized input payload, prerequisite keys, and priority level.
 */
export interface MutateLanePlanSpawnedItem {
  /** Deduplication key for the spawned work item. */
  readonly itemKey: string;
  /** JSON-serialized flow input payload for the spawned item. */
  readonly inputJson: string;
  /** Prerequisite work item keys that must complete before this item starts. */
  readonly dependsOn: readonly string[];
  /** Scheduling priority level assigned to the spawned item. */
  readonly priority: 'low' | 'normal' | 'high' | 'critical';
}

/**
 * Request record passed to `LedgerStore.mutateLanePlan()` when spawning prerequisite tasks or adding dependencies.
 *
 * Validated atomically by `LedgerStore` for DAG acyclicity and `maxPrerequisiteDepth` compliance.
 */
export interface MutateLanePlanRequest {
  /** Identifier of the target `LaneNode`. */
  readonly laneId: string;
  /** Run identifier of the parent actor mutating the lane plan. */
  readonly parentRunId: string;
  /** Work item key of the parent run. */
  readonly parentItemKey: string;
  /** Maximum allowed prerequisite chain depth enforced atomically in the ledger. */
  readonly maxPrerequisiteDepth: number;
  /** Optional newly spawned work items to enqueue into the lane. */
  readonly spawnedItems?: readonly MutateLanePlanSpawnedItem[];
  /** Optional existing work item keys added as prerequisites of `parentItemKey`. */
  readonly addedDependencies?: readonly string[];
}
