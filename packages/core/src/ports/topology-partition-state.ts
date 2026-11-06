/**
 * Live or overlay state record for a single logical partition in `TopologyStore`.
 *
 * Tracks the partition identifier, monotonic contract epoch, contract text, update timestamp,
 * and optional last-mutating run ID across per-run Copy-on-Write overlays.
 */
export interface TopologyPartitionState {
  /** Logical identifier of the partition. */
  readonly partitionId: string;
  /** Monotonic integer contract epoch number. */
  readonly epoch: number;
  /** Current Markdown or structured contract text for the partition. */
  readonly contractText: string;
  /** ISO-8601 timestamp when the partition contract was last updated. */
  readonly updatedAt: string;
  /** Optional `runId` that most recently mutated this partition's contract in the active overlay lineage. */
  readonly lastMutatedByRunId?: string;
}
