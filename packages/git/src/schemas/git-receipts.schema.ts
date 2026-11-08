import { z } from '@paraharness/core';

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

/**
 * Zod schema validating input arguments for the `readRefFile` git object-store inspection tool.
 */
export const ReadRefFileInputSchema = z.object({
  ref: z.string(),
  path: z.string(),
});

/**
 * Inferred TypeScript input shape for `readRefFile`.
 */
export type ReadRefFileInput = z.infer<typeof ReadRefFileInputSchema>;

/**
 * Zod schema validating input arguments for the `diffRefs` git object-store inspection tool.
 */
export const DiffRefsInputSchema = z.object({
  fromRef: z.string(),
  toRef: z.string(),
  paths: z.array(z.string()).optional(),
});

/**
 * Inferred TypeScript input shape for `diffRefs`.
 */
export type DiffRefsInput = z.infer<typeof DiffRefsInputSchema>;

/**
 * Zod schema validating input arguments for the `listRefFiles` git object-store inspection tool.
 */
export const ListRefFilesInputSchema = z.object({
  ref: z.string(),
  prefix: z.string().optional(),
});

/**
 * Inferred TypeScript input shape for `listRefFiles`.
 */
export type ListRefFilesInput = z.infer<typeof ListRefFilesInputSchema>;

/**
 * Zod schema validating input arguments for the `diffCandidates` candidate comparison tool.
 */
export const DiffCandidatesInputSchema = z.object({
  fromBranchIndex: z.number().int().min(0),
  toBranchIndex: z.number().int().min(0),
  paths: z.array(z.string()).optional(),
});

/**
 * Inferred TypeScript input shape for `diffCandidates`.
 */
export type DiffCandidatesInput = z.infer<typeof DiffCandidatesInputSchema>;

/**
 * Zod schema validating input arguments for the `readCandidateFile` candidate comparison tool.
 */
export const ReadCandidateFileInputSchema = z.object({
  branchIndex: z.number().int().min(0),
  path: z.string(),
});

/**
 * Inferred TypeScript input shape for `readCandidateFile`.
 */
export type ReadCandidateFileInput = z.infer<typeof ReadCandidateFileInputSchema>;

/**
 * Zod schema validating input arguments for the `evalInCandidates` candidate benchmark tool.
 */
export const EvalInCandidatesInputSchema = z.object({
  branchIndices: z.array(z.number().int().min(0)).optional(),
  branchIndex: z.number().int().min(0).optional(),
  argv: z.array(z.string()).optional(),
  command: z.union([z.string(), z.array(z.string())]).optional(),
});

/**
 * Inferred TypeScript input shape for `evalInCandidates`.
 */
export type EvalInCandidatesInput = z.infer<typeof EvalInCandidatesInputSchema>;

/**
 * Zod schema validating a single candidate entry passed to `git.mergeQueue`.
 */
export const MergeTrainInputItemSchema = z.union([
  z.string(),
  z.object({
    branchName: z.string().optional(),
    ref: z.string().optional(),
    headRef: z.string().optional(),
    baseRef: z.string().optional(),
  }),
]);

/**
 * Inferred TypeScript shape for a single candidate entry passed to `git.mergeQueue`.
 */
export type MergeTrainInputItem = z.infer<typeof MergeTrainInputItemSchema>;

/**
 * Zod schema validating the step input payload accepted by `git.mergeQueue`.
 */
export const MergeTrainStepInputSchema = z.union([
  z.array(MergeTrainInputItemSchema),
  z.object({
    candidates: z.array(MergeTrainInputItemSchema).optional(),
    branches: z.array(MergeTrainInputItemSchema).optional(),
    refs: z.array(MergeTrainInputItemSchema).optional(),
    receipts: z.array(MergeTrainInputItemSchema).optional(),
  }),
]);

/**
 * Inferred TypeScript shape for the step input payload accepted by `git.mergeQueue`.
 */
export type MergeTrainStepInput = z.infer<typeof MergeTrainStepInputSchema>;

