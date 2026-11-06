/**
 * Result returned by `TopologyStore.commitRunOverlay()` when a run's overlay lands in the base store.
 *
 * Lists all committed run IDs (including absorbed prerequisite overlays) and the map of mutated
 * partition IDs to their newly allocated monotonic base epoch numbers.
 */
export interface CommitRunOverlayResult {
  /** Identifiers of the target run and any absorbed ancestor/prerequisite runs committed in the transaction. */
  readonly committedRunIds: readonly string[];
  /** Map of mutated `partitionId` to its newly allocated monotonic base epoch number. */
  readonly updatedEpochs: ReadonlyMap<string, number>;
}
