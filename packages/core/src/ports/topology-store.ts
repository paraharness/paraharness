import type { CommitRunOverlayResult } from './commit-run-overlay-result.js';
import type { TopologyPartitionState } from './topology-partition-state.js';

export type { CommitRunOverlayResult } from './commit-run-overlay-result.js';
export type { TopologyPartitionState } from './topology-partition-state.js';

/**
 * Runtime storage port for run-isolated Copy-on-Write partition contract overlays and 3-way commits.
 *
 * Always resolves file or database paths against the immutable host process root (Invariant 5).
 */
export interface TopologyStore {
  /**
   * Loads the partition state map for `runId` (merging any uncommitted per-run CoW overlay over the base store).
   *
   * Pins each partition's initial `baseContractTextAtAcquire` when `runId` first inspects the partition.
   *
   * @param {string} [runId] - Optional active flow run identifier.
   *
   * @returns {Promise<ReadonlyMap<string, TopologyPartitionState>>} Map of `partitionId` to partition state.
   */
  getPartitions(runId?: string): Promise<ReadonlyMap<string, TopologyPartitionState>>;

  /**
   * Writes a contract update to `runId`'s isolated Copy-on-Write overlay.
   *
   * Increments the partition's overlay epoch at most once per `(runId, partitionId)` unless reset
   * by `resetRunOverlay()`, and tags the mutation with `stepExecId` for step-scoped rollback.
   *
   * @param {string} runId           - Active flow run identifier.
   * @param {string} partitionId     - Target partition identifier.
   * @param {string} newContractText - Updated contract text.
   * @param {string} [stepExecId]    - Optional active step execution identifier.
   *
   * @returns {Promise<{ readonly newEpoch: number }>} Updated overlay epoch for `partitionId`.
   */
  updateContract(
    runId: string,
    partitionId: string,
    newContractText: string,
    stepExecId?: string,
  ): Promise<{ readonly newEpoch: number }>;

  /**
   * Merges prerequisite runs' `ACTIVE` or `SEALED_UNMERGED` overlays into `targetRunId`'s overlay.
   *
   * Advances `targetRunId`'s 3-way merge-base text for each absorbed partition so stacked PRs
   * never false-conflict when committed sequentially.
   *
   * @param {string}            targetRunId        - Dependent run absorbing the prerequisite overlays.
   * @param {readonly string[]} prerequisiteRunIds - Prerequisite run identifiers to merge from.
   *
   * @returns {Promise<void>} Resolves once prerequisite overlays are merged.
   */
  syncRunOverlays(targetRunId: string, prerequisiteRunIds: readonly string[]): Promise<void>;

  /**
   * Resets uncommitted overlay mutations for `runId` at either the `'step'` or `'run'` scope.
   *
   * Preserves completed step mutations when `scope === 'step'` and rolls back the entire run overlay when `scope === 'run'`.
   *
   * @param {string}                                                            runId  - Target flow run identifier.
   * @param {{ readonly scope?: 'step' | 'run'; readonly stepExecId?: string }} [opts] - Reset scope options.
   *
   * @returns {Promise<void>} Resolves once matching uncommitted overlay mutations are rolled back.
   */
  resetRunOverlay(
    runId: string,
    opts?: { readonly scope?: 'step' | 'run'; readonly stepExecId?: string },
  ): Promise<void>;

  /**
   * Transitions `runId`'s overlay to `SEALED_UNMERGED` upon flow exit `'done'` when awaiting an external merge signal.
   *
   * Allows dependent stacked runs to absorb the sealed overlay via `syncRunOverlays` without polluting the base store.
   *
   * @param {string} runId - Completed flow run identifier.
   *
   * @returns {Promise<void>} Resolves once the overlay is sealed.
   */
  sealRunOverlay(runId: string): Promise<void>;

  /**
   * Atomically commits `runId`'s overlay (and any absorbed ancestor/prerequisite `SEALED_UNMERGED` overlays)
   * to the base store using a 3-way merge against `baseContractTextAtAcquire`.
   *
   * Allocates monotonic base epoch numbers at commit time and returns the committed run IDs and updated epochs.
   *
   * @param {string} runId - Flow run identifier whose changes landed.
   *
   * @returns {Promise<CommitRunOverlayResult>} Committed run IDs and newly allocated base epoch numbers.
   */
  commitRunOverlay(runId: string): Promise<CommitRunOverlayResult>;

  /**
   * Discards `runId`'s overlay when a run fails, a PR closes unmerged, or `maxSealedAgeHours` expires.
   *
   * Removes all uncommitted or sealed overlay rows for `runId` without modifying the base store.
   *
   * @param {string} runId - Flow run identifier whose overlay should be discarded.
   *
   * @returns {Promise<void>} Resolves once the overlay is removed.
   */
  discardRunOverlay(runId: string): Promise<void>;
}
