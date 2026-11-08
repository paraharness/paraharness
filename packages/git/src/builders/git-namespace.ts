import {
  GitAbortMetaSchema,
  GitScopeReceiptSchema,
  GitSyncReceiptSchema,
} from '../schemas/git-receipts.schema.js';
import { createGitCandidateComparisonTools } from './create-git-candidate-comparison-tools.js';
import { createGitCommitAndPushBuilder } from './create-git-commit-and-push-builder.js';
import { createGitCowWorktreeBuilder } from './create-git-cow-worktree-builder.js';
import { createGitDiscardBranchBuilder } from './create-git-discard-branch-builder.js';
import { createGitKeepWorktreeBuilder } from './create-git-keep-worktree-builder.js';
import { createGitMergeQueueBuilder } from './create-git-merge-queue-builder.js';
import { createGitPatchEquivalenceBuilder } from './create-git-patch-equivalence-builder.js';
import { createGitPublicSurfaceCrossTesterBuilder } from './create-git-public-surface-cross-tester-builder.js';
import { createGitRefReaderTools } from './create-git-ref-reader-tools.js';
import { createGitResetWorktreeBuilder } from './create-git-reset-worktree-builder.js';
import { createGitSnapshotAndResetBuilder } from './create-git-snapshot-and-reset-builder.js';
import type { GitNamespace } from './git-namespace-contract.js';

/**
 * Frozen `git` DSL builder and receipt schema namespace (`@paraharness/git`).
 */
export const git: GitNamespace = Object.freeze<GitNamespace>({
  ScopeReceiptSchema: GitScopeReceiptSchema,
  SyncReceiptSchema: GitSyncReceiptSchema,
  AbortMetaSchema: GitAbortMetaSchema,
  cowWorktree: createGitCowWorktreeBuilder,
  commitAndPush: createGitCommitAndPushBuilder,
  mergeQueue: createGitMergeQueueBuilder,
  snapshotAndReset: createGitSnapshotAndResetBuilder,
  keepWorktree: createGitKeepWorktreeBuilder,
  resetWorktree: createGitResetWorktreeBuilder,
  discardBranch: createGitDiscardBranchBuilder,
  publicSurfaceCrossTester: createGitPublicSurfaceCrossTesterBuilder,
  patchEquivalence: createGitPatchEquivalenceBuilder,
  refReaderTools: createGitRefReaderTools,
  candidateComparisonTools: createGitCandidateComparisonTools,
});
