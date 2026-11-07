import type { OversizedUntrackedBlobRecord } from '../git-checkpoint-payload.js';

/**
 * Staged checkpoint tree SHA and spilled oversized untracked blob metadata.
 */
export interface StagedCheckpointTreeResult {
  /** Resolved `HEAD` commit SHA at the moment the checkpoint was staged. */
  readonly headSha: string;
  /** Root Git tree SHA produced by `git write-tree` on the temporary index. */
  readonly treeSha: string;
  /** Map of repository-relative untracked paths exceeding `maxUntrackedBytes` to spilled blob descriptors. */
  readonly oversizedUntrackedBlobs: Readonly<Record<string, OversizedUntrackedBlobRecord>>;
}
