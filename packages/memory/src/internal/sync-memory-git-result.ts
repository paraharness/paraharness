import type { MemoryMeta, MemoryRecord } from '../schemas/memory-record.schema.js';
import type { MemoryBucketStatus } from '../schemas/memory-tools.schema.js';

/**
 * Result returned by `syncMemoryGit` (§8.2.2–§8.2.3).
 */
export interface SyncMemoryGitResult {
  /** Whether a local or reconciled Git commit was created. */
  readonly gitCommitted: boolean;
  /** Whether changes were pushed to `origin/<branch>`. */
  readonly gitPushed: boolean;
  /** Final active ledger records on disk after any 3-way push reconciliation. */
  readonly records: readonly MemoryRecord[];
  /** Final monotonic high-water-mark metadata on disk after any 3-way push reconciliation. */
  readonly meta: MemoryMeta;
  /** Transitive ID remapping (`oldId -> newId`) accumulated across push retry iterations. */
  readonly cumulativeIdRemap: ReadonlyMap<string, string>;
  /** Post-reconcile `MemoryBucketStatus` for `capCheckCandidate` (or `null` when not applicable). */
  readonly bucketStatusAfter: MemoryBucketStatus | null;
}
