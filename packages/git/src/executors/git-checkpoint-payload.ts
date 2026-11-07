import type { HarnessMetaRecord } from '../schemas/git-receipts.schema.js';

/**
 * Metadata descriptor for an untracked file exceeding `maxUntrackedFileSizeBytes` spilled to `<gitdir>/harness-ckpt-blobs/`.
 *
 * Stores the content-addressed `blobKey`, POSIX file `mode`, and byte `size` so `restoreCheckpoint`
 * can copy the oversized file back into the working tree without bloating the temporary Git index.
 */
export interface OversizedUntrackedBlobRecord {
  /** Content-addressed filename inside `<gitdir>/harness-ckpt-blobs/` (`${size}_${mtimeNs}_${sha256}`). */
  readonly blobKey: string;
  /** POSIX file permission mode bits captured via `lstat(2)`. */
  readonly mode: number;
  /** File size in bytes captured via `lstat(2)`. */
  readonly size: number;
}

/**
 * Serialized checkpoint payload produced by `GitCowWorktreeScopeDriver.serializeCheckpoint()`.
 *
 * Captures worktree-local `.git` metadata (`headSha`, `headRawContent`, `indexTreeSha`, `infoExcludeContent`, `meta`),
 * the porcelain v2 `statusMap`, the temporary-index `treeSha`, and any `oversizedUntrackedBlobs`.
 */
export interface GitCheckpointPayload {
  /** Resolved commit SHA of `HEAD` (`git rev-parse HEAD`). */
  readonly headSha: string;
  /** Exact raw file content of `<gitdir>/HEAD`. */
  readonly headRawContent: string;
  /** Tree OID of the live `<gitdir>/index` at checkpoint time. */
  readonly indexTreeSha: string;
  /** Raw content of `<gitdir>/info/exclude`, or `null` when absent. */
  readonly infoExcludeContent: string | null;
  /** Snapshot of `<gitdir>/harness-meta.json` at checkpoint time. */
  readonly meta: HarnessMetaRecord;
  /** Map from repository-relative file path to `${mode}:${sha256}` (or `'DELETED'`). */
  readonly statusMap: Readonly<Record<string, string>>;
  /** Paths ignored at checkpoint time (used when a `.gitignore` file changes mid-step). */
  readonly ignoredPaths: readonly string[];
  /** Digest of `node_modules` tree state at checkpoint time for tamper detection in `diffEffects`. */
  readonly nodeModulesDigest: string;
  /** Git tree SHA capturing `headSha` plus all dirty tracked and non-oversized untracked files. */
  readonly treeSha: string;
  /** Map of untracked files exceeding `maxUntrackedFileSizeBytes` stored in `<gitdir>/harness-ckpt-blobs/`. */
  readonly oversizedUntrackedBlobs: Readonly<Record<string, OversizedUntrackedBlobRecord>>;
}
