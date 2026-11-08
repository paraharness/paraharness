import type {
  AstBuilder,
  CrossVerifierBuilder,
  GitCandidateComparisonToolNode,
  GitDiscardBranchNode,
  GitKeepWorktreeNode,
  GitPatchEquivalenceNode,
  GitPublicSurfaceCrossTesterNode,
  GitRefReaderToolNode,
  GitScopeReceipt,
  GitSnapshotAndResetNode,
  GitWorktreeHandle,
  MaybeBuilder,
  NodeRunnerNode,
} from '@paraharness/core';
import type {
  GitAbortMetaSchema,
  GitScopeReceiptSchema,
  GitSyncReceiptSchema,
} from '../schemas/git-receipts.schema.js';
import type { GitCommitAndPushBuilder } from './git-commit-and-push-builder.js';
import type { GitCommitAndPushOptions } from './git-commit-and-push-options.js';
import type { GitCowWorktreeBuilder } from './git-cow-worktree-builder.js';
import type { GitCowWorktreeOptions } from './git-cow-worktree-options.js';
import type { GitMergeQueueBuilder } from './git-merge-queue-builder.js';
import type { GitMergeQueueOptions } from './git-merge-queue-options.js';
import type { GitPublicSurfaceCrossTesterOptions } from './git-public-surface-cross-tester-options.js';

/**
 * Public `git` builder and schema namespace contract (`import { git } from '@paraharness/git'`).
 *
 * Mounts `ScopeReceiptSchema`, `SyncReceiptSchema`, `AbortMetaSchema`, and all declarative
 * Copy-on-Write worktree, hook, cross-verifier, tool, and delivery step builders.
 */
export interface GitNamespace {
  /** Zod schema validating `GitScopeReceipt` objects returned by `inspect()` and `commitChild()`. */
  readonly ScopeReceiptSchema: typeof GitScopeReceiptSchema;
  /** Zod schema validating `GitSyncReceipt` objects returned by `syncChild()` and `syncRoot()`. */
  readonly SyncReceiptSchema: typeof GitSyncReceiptSchema;
  /** Zod schema validating `GitAbortMeta` objects returned by `git.snapshotAndReset()`. */
  readonly AbortMetaSchema: typeof GitAbortMetaSchema;

  /**
   * Creates a fluent builder for a Tier-3 branchable Copy-on-Write Git worktree scope.
   *
   * Provisions disjoint sibling `<dir>/roots/<runId>` and `<dir>/forks/<runId>/<forkId>` worktrees at runtime.
   *
   * @param {GitCowWorktreeOptions} options - Host repository path and worktree base directory.
   *
   * @returns {GitCowWorktreeBuilder} Immutable fluent worktree scope builder.
   */
  cowWorktree(options: GitCowWorktreeOptions): GitCowWorktreeBuilder;

  /**
   * Creates a fluent builder for a retry-safe squash, rebase, verify, and push step.
   *
   * Compiles into a passive `GitCommitAndPushNode<TIn>` dispatched via `RuntimeExecutorRegistry.steps`.
   *
   * @template TIn Step input payload type.
   *
   * @param {string}                       id      - Unique step node identifier.
   * @param {GitCommitAndPushOptions<TIn>} options - Remote branch and commit message projections.
   *
   * @returns {GitCommitAndPushBuilder<TIn>} Immutable fluent commit-and-push step builder.
   */
  commitAndPush<TIn = unknown>(
    id: string,
    options: GitCommitAndPushOptions<TIn>,
  ): GitCommitAndPushBuilder<TIn>;

  /**
   * Creates a fluent builder for a cumulative batch merge-train verification step.
   *
   * Constructs a speculative rebase chain $R_1 \dots R_k$ up to `maxBatchSize` and binary-bisects on failure.
   *
   * @template TIn  Validated step input type.
   * @template TOut Validated step output type.
   *
   * @param {string}                          id      - Unique merge queue step identifier.
   * @param {GitMergeQueueOptions<TIn, TOut>} options - Target branch, batch size, and verification check.
   *
   * @returns {GitMergeQueueBuilder<TIn, TOut>} Immutable fluent merge queue step builder.
   */
  mergeQueue<TIn = unknown, TOut = unknown>(
    id: string,
    options: GitMergeQueueOptions<TIn, TOut>,
  ): GitMergeQueueBuilder<TIn, TOut>;

  /**
   * Creates an idempotent abort hook builder snapshotting the dirty worktree to `refs/harness/aborted/<run-id>/<stepExecId>`.
   *
   * Resets the working tree to `handle.baseRef` and clears `unresolvedConflictPaths` after snapshotting.
   *
   * @param {string} [id] - Optional custom abort hook identifier.
   *
   * @returns {AstBuilder<GitSnapshotAndResetNode>} Immutable abort hook builder.
   */
  snapshotAndReset(id?: string): AstBuilder<GitSnapshotAndResetNode>;

  /**
   * Creates a rewind hook builder preserving the active worktree and topology overlay in-place (`resetsRunOverlay: false`).
   *
   * Used with `.rewindTo(stepId, { onRewind: git.keepWorktree() })` for live steering without discarding work.
   *
   * @param {string} [id] - Optional custom rewind hook identifier.
   *
   * @returns {AstBuilder<GitKeepWorktreeNode>} Immutable rewind hook builder.
   */
  keepWorktree(id?: string): AstBuilder<GitKeepWorktreeNode>;

  /**
   * Creates a rewind hook builder resetting the worktree to `targetStepBaseScopeCheckpoint` (`resetsRunOverlay: true`).
   *
   * Restores both the physical working tree and the run's Copy-on-Write topology overlay to the target step entry.
   *
   * @param {string} [id] - Optional custom rewind hook identifier.
   *
   * @returns {AstBuilder<GitDiscardBranchNode>} Immutable rewind hook builder.
   */
  resetWorktree(id?: string): AstBuilder<GitDiscardBranchNode>;

  /**
   * Alias for `git.resetWorktree()` compiling to `GitDiscardBranchNode` (`resetsRunOverlay: true`).
   *
   * Restores the worktree to `targetStepBaseScopeCheckpoint` and discards uncommitted overlay mutations.
   *
   * @param {string} [id] - Optional custom rewind hook identifier.
   *
   * @returns {AstBuilder<GitDiscardBranchNode>} Immutable rewind hook builder.
   */
  discardBranch(id?: string): AstBuilder<GitDiscardBranchNode>;

  /**
   * Creates a `CrossVerifierBuilder` transplanting boundary-only tests across speculative worktree candidates.
   *
   * Parses test imports against `partitionMap.partitions[*].boundaryGlobs` and cross-executes eligible tests.
   *
   * @param {GitPublicSurfaceCrossTesterOptions} options - Subprocess runner and partition map configuration.
   *
   * @returns {CrossVerifierBuilder<GitWorktreeHandle, GitScopeReceipt, Record<string, unknown>, GitPublicSurfaceCrossTesterNode>} Immutable cross-verifier builder.
   */
  publicSurfaceCrossTester(
    options: GitPublicSurfaceCrossTesterOptions,
  ): CrossVerifierBuilder<
    GitWorktreeHandle,
    GitScopeReceipt,
    Record<string, unknown>,
    GitPublicSurfaceCrossTesterNode
  >;

  /**
   * Creates a `CrossVerifierBuilder` grouping speculative candidates by normalized patch equivalence.
   *
   * Computes canonicalized patch digests and equivalence classes across surviving tournament branches.
   *
   * @param {string} [id] - Optional custom cross-verifier identifier.
   *
   * @returns {CrossVerifierBuilder<GitWorktreeHandle, GitScopeReceipt, Record<string, unknown>, GitPatchEquivalenceNode>} Immutable cross-verifier builder.
   */
  patchEquivalence(
    id?: string,
  ): CrossVerifierBuilder<
    GitWorktreeHandle,
    GitScopeReceipt,
    Record<string, unknown>,
    GitPatchEquivalenceNode
  >;

  /**
   * Creates the read-only git ref inspection tool bundle (`readRefFile`, `diffRefs`, `listRefFiles`).
   *
   * Enables actors to inspect `refs/harness/aborted/<run-id>/<stepExecId>` snapshots against the object store.
   *
   * @param {MaybeBuilder<NodeRunnerNode>} runner - Subprocess runner pool governing git command slots.
   *
   * @returns {readonly GitRefReaderToolNode<GitWorktreeHandle>[]} Frozen tuple of ref reader tool AST nodes.
   */
  refReaderTools(
    runner: MaybeBuilder<NodeRunnerNode>,
  ): readonly GitRefReaderToolNode<GitWorktreeHandle>[];

  /**
   * Creates the speculative candidate comparison tool bundle (`diffCandidates`, `readCandidateFile`, `evalInCandidates`).
   *
   * Enables `candidateArbiter` and `.refineWinnerWhen()` to compare candidate refs and run sandboxed benchmarks.
   *
   * @param {MaybeBuilder<NodeRunnerNode>} runner - Subprocess runner pool governing git and benchmark command slots.
   *
   * @returns {readonly GitCandidateComparisonToolNode<GitWorktreeHandle>[]} Frozen tuple of candidate comparison tool AST nodes.
   */
  candidateComparisonTools(
    runner: MaybeBuilder<NodeRunnerNode>,
  ): readonly GitCandidateComparisonToolNode<GitWorktreeHandle>[];
}
