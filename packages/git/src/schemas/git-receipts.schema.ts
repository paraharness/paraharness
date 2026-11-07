import { z } from '@harness-dsl/core';

/**
 * Zod schema validating `GitScopeReceipt` objects returned by `inspect()` and `commitChild()`.
 */
export const GitScopeReceiptSchema = z.object({
  headRef: z.string(),
  baseRef: z.string(),
  branchName: z.string().optional(),
  baseBranch: z.string().default('main'),
  diffStat: z.string(),
  mutatedFiles: z.array(z.string()).readonly(),
});

/**
 * Zod schema validating `GitSyncReceipt` objects returned by `syncChild()` and `syncRoot()`.
 */
export const GitSyncReceiptSchema = z.object({
  rebasedOntoRef: z.string(),
  baseBranch: z.string().default('main'),
  updatedFiles: z.array(z.string()).readonly(),
});

/**
 * Zod schema validating `GitAbortMeta` objects returned by `git.snapshotAndReset()`.
 */
export const GitAbortMetaSchema = z.object({
  abortedSnapshotRef: z.string(),
  resetToRef: z.string(),
});

/**
 * Zod schema validating persistent `<gitdir>/harness-meta.json` worktree lineage and recovery metadata.
 */
export const HarnessMetaSchema = z.object({
  baseRef: z.string(),
  baseBranch: z.string().default('main'),
  branchName: z.string().optional(),
  unresolvedConflictPaths: z.record(z.string(), z.string()).default({}),
  pendingParentHeadSha: z.string().optional(),
  inFlightMerge: z
    .object({
      targetHeadSha: z.string(),
      mergedTreeSha: z.string(),
      priorTreeSha: z.string(),
      unresolvedConflictPaths: z.record(z.string(), z.string()),
    })
    .optional(),
  inFlightCommitAndPush: z
    .object({
      preStepHeadSha: z.string(),
      preStepBaseRef: z.string(),
      targetBranch: z.string().optional(),
    })
    .optional(),
});

/**
 * Inferred TypeScript record shape for `<gitdir>/harness-meta.json`.
 */
export type HarnessMetaRecord = z.infer<typeof HarnessMetaSchema>;
