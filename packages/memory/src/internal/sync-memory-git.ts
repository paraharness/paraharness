import path from 'node:path';
import { MemoryHarnessError } from '../memory-harness-error.js';
import type { MemoryConfig } from '../schemas/memory-config.schema.js';
import type { MemoryRecord } from '../schemas/memory-record.schema.js';
import type { MemoryBucketStatus } from '../schemas/memory-tools.schema.js';
import { configureOriginRemote } from './configure-origin-remote.js';
import { ensureMemoryGitignore } from './ensure-memory-gitignore.js';
import { execGitCommand } from './exec-git-command.js';
import type { MemoryBranchLedgerState } from './memory-branch-ledger-state.js';
import { MAX_GIT_PUSH_RETRIES, MEMORY_META_FILENAME } from './memory-protocol.constants.js';
import { readGitRevisionLedgerState } from './read-git-revision-ledger-state.js';
import { readMemoryLedger } from './read-memory-ledger.js';
import {
  composeCumulativeIdRemap,
  reconcileDivergedMemoryLedgers,
} from './reconcile-diverged-memory-ledgers.js';
import {
  isRecordActiveForRepo,
  resolveRecordCapBucket,
  type CapCandidateRecord,
} from './resolve-record-cap-bucket.js';
import { stageAndCommitMemoryCheckout } from './stage-and-commit-memory-checkout.js';
import type { SyncMemoryGitResult } from './sync-memory-git-result.js';
import { writeMemoryLedger } from './write-memory-ledger.js';

/**
 * Parameter object for `syncMemoryGit`.
 */
export interface SyncMemoryGitParams {
  /** Absolute path to the workspace root directory. */
  readonly workspaceRoot: string;
  /** Validated unified memory configuration. */
  readonly config: MemoryConfig;
  /** Short operation summary used in commit messages (`"memory(<repoId>): <opSummary>"`). */
  readonly opSummary: string;
  /** Optional pre-operation local ledger/meta snapshot restored if post-push reconciliation exceeds `hardCap` (§8.2.3 Step 3). */
  readonly preOpSnapshot?: MemoryBranchLedgerState;
  /** Optional added or bucket-transitioned candidate record checked for post-reconcile `CAP_EXCEEDED`. */
  readonly capCheckCandidate?: CapCandidateRecord;
  /** Optional tracked workspace-relative POSIX file list for bucket evaluation. */
  readonly repoFiles?: readonly string[];
  /** Optional UTC timestamp override in epoch milliseconds. */
  readonly nowMs?: number;
}

/**
 * Parameter object for `rollbackToPreOpReconciledAndThrow`.
 */
export interface RollbackToPreOpReconciledParams {
  /** Active `syncMemoryGit` parameters. */
  readonly syncParams: SyncMemoryGitParams;
  /** Absolute path to `<checkoutDir>`. */
  readonly checkoutDir: string;
  /** Absolute path to `<ledgerPath>`. */
  readonly absLedgerPath: string;
  /** Common ancestor ledger state. */
  readonly baseState: MemoryBranchLedgerState;
  /** Remote `origin/<branch>` ledger state. */
  readonly remoteState: MemoryBranchLedgerState;
  /** Post-reconcile bucket status that violated the capacity wall. */
  readonly exceededStatus: MemoryBucketStatus;
}

/**
 * Parameter object for `executeSingleDivergedPushReconcileAttempt`.
 */
export interface SingleDivergedPushReconcileAttemptParams {
  /** Active `syncMemoryGit` parameters. */
  readonly syncParams: SyncMemoryGitParams;
  /** 1-based push retry attempt number (`1..MAX_GIT_PUSH_RETRIES`). */
  readonly attempt: number;
  /** Absolute path to `<checkoutDir>`. */
  readonly checkoutDir: string;
  /** Absolute path to `<ledgerPath>`. */
  readonly absLedgerPath: string;
  /** Checkout-relative POSIX path to `memory.jsonl`. */
  readonly relLedgerPath: string;
  /** Checkout-relative POSIX path to `memory.meta.json`. */
  readonly relMetaPath: string;
  /** Current local branch ledger state prior to this retry attempt. */
  readonly currentLocalState: MemoryBranchLedgerState;
  /** Mutable cumulative ID remap updated in-place across retries. */
  readonly cumulativeIdRemap: Map<string, string>;
}

/**
 * Evaluates `bucketStatusAfter` for `params.capCheckCandidate` against `records` when applicable.
 *
 * @param {SyncMemoryGitParams}     params  - Sync parameters containing `capCheckCandidate` and `config`.
 * @param {readonly MemoryRecord[]} records - Active records to evaluate against.
 *
 * @returns {MemoryBucketStatus | null} Resolved bucket status, or `null` if no active candidate applies to `config.repoId`.
 */
function evaluateCandidateBucketAfter(
  params: SyncMemoryGitParams,
  records: readonly MemoryRecord[],
): MemoryBucketStatus | null {
  if (
    params.capCheckCandidate === undefined ||
    !isRecordActiveForRepo(params.capCheckCandidate, params.config.repoId)
  ) {
    return null;
  }
  return resolveRecordCapBucket({
    candidate: params.capCheckCandidate,
    records,
    config: params.config,
    repoFiles: params.repoFiles,
  });
}

/**
 * Restores `preOpSnapshot` reconciled with `origin/<branch>` when a post-push 3-way merge exceeds
 * `hardCap` or `maxTotalRecords`, then throws `MemoryHarnessError('CAP_EXCEEDED')` (§8.2.3 Step 3).
 *
 * @param {RollbackToPreOpReconciledParams} params - Sync parameters, checkout/ledger paths, ancestor/remote states, and exceeded bucket status.
 *
 * @returns {Promise<never>} Always throws `MemoryHarnessError` with `'CAP_EXCEEDED'`.
 *
 * @throws {MemoryHarnessError} Always throws with code `'CAP_EXCEEDED'`.
 */
async function rollbackToPreOpReconciledAndThrow(
  params: RollbackToPreOpReconciledParams,
): Promise<never> {
  const branch = params.syncParams.config.storage.git.branch;
  const relLedgerPath = path.relative(params.checkoutDir, params.absLedgerPath).replaceAll('\\', '/');
  const relMetaPath = path.posix.join(path.posix.dirname(relLedgerPath), MEMORY_META_FILENAME);
  const preOp = params.syncParams.preOpSnapshot ?? params.baseState;
  const rollbackReconciled = reconcileDivergedMemoryLedgers(
    params.baseState,
    preOp,
    params.remoteState,
  );
  await execGitCommand({
    cwd: params.checkoutDir,
    args: ['reset', '--hard', `origin/${branch}`],
  });
  await ensureMemoryGitignore(params.checkoutDir);
  await writeMemoryLedger({
    ledgerPath: params.absLedgerPath,
    records: rollbackReconciled.records,
    meta: rollbackReconciled.meta,
  });
  if (params.syncParams.config.storage.git.autoCommit) {
    await stageAndCommitMemoryCheckout({
      checkoutDir: params.checkoutDir,
      relLedgerPath,
      relMetaPath,
      commitMessage: `memory(${params.syncParams.config.repoId}): reconcile pre-operation state`,
    });
  }
  throw new MemoryHarnessError(
    'CAP_EXCEEDED',
    `Capacity exceeded after reconciling with 'origin/${branch}' in bucket '${params.exceededStatus.bucketId}' (count ${params.exceededStatus.currentCount}, hardCap ${params.exceededStatus.hardCap ?? 'none'}, total ${params.exceededStatus.totalRecordsCount}/${params.exceededStatus.maxTotalRecords ?? 'unlimited'}).`,
    { bucketStatus: params.exceededStatus },
  );
}

/**
 * Executes a single diverged push reconciliation iteration: fetches `origin/<branch>`, resolves
 * `merge-base`, performs 3-way reconciliation, verifies post-reconcile capacity (rolling back on
 * overflow), resets to `origin/<branch>`, writes the merged ledger, commits if dirty, and pushes
 * (§8.2.3 Steps 1–3).
 *
 * @param {SingleDivergedPushReconcileAttemptParams} params - Per-attempt reconciliation parameters.
 *
 * @returns {Promise<{ readonly pushed: boolean; readonly reconcileCommitted: boolean; readonly nextLocalState: MemoryBranchLedgerState }>} Attempt outcome and updated local state.
 *
 * @throws {MemoryHarnessError} With `'CAP_EXCEEDED'` on capacity overflow or `'GIT_SYNC_FAILED'` on fetch/reset/commit error.
 */
async function executeSingleDivergedPushReconcileAttempt(
  params: SingleDivergedPushReconcileAttemptParams,
): Promise<{
  readonly pushed: boolean;
  readonly reconcileCommitted: boolean;
  readonly nextLocalState: MemoryBranchLedgerState;
}> {
  const branch = params.syncParams.config.storage.git.branch;
  const fetchRes = await execGitCommand({
    cwd: params.checkoutDir,
    args: ['fetch', 'origin', branch],
  });
  if (fetchRes.exitCode !== 0) {
    throw new MemoryHarnessError(
      'GIT_SYNC_FAILED',
      `Failed to fetch 'origin/${branch}' during push retry ${params.attempt}: ${fetchRes.stderr}`,
      {
        checkoutDir: params.checkoutDir,
        branch,
        attempt: params.attempt,
        stderr: fetchRes.stderr,
      },
    );
  }
  const mergeBaseRes = await execGitCommand({
    cwd: params.checkoutDir,
    args: ['merge-base', 'HEAD', `origin/${branch}`],
  });
  const baseSha = mergeBaseRes.exitCode === 0 ? mergeBaseRes.stdout.trim() : null;
  const baseState = await readGitRevisionLedgerState({
    checkoutDir: params.checkoutDir,
    gitRef: baseSha,
    relLedgerPath: params.relLedgerPath,
    relMetaPath: params.relMetaPath,
  });
  const remoteState = await readGitRevisionLedgerState({
    checkoutDir: params.checkoutDir,
    gitRef: `origin/${branch}`,
    relLedgerPath: params.relLedgerPath,
    relMetaPath: params.relMetaPath,
  });
  const reconciled = reconcileDivergedMemoryLedgers(
    baseState,
    params.currentLocalState,
    remoteState,
  );
  const postBucket = evaluateCandidateBucketAfter(params.syncParams, reconciled.records);
  const hardCapExceeded =
    postBucket !== null &&
    postBucket.hardCap !== null &&
    postBucket.currentCount > postBucket.hardCap;
  const totalExceeded =
    postBucket !== null &&
    params.syncParams.config.maxTotalRecords !== undefined &&
    postBucket.totalRecordsCount > params.syncParams.config.maxTotalRecords;
  if (postBucket !== null && (hardCapExceeded || totalExceeded)) {
    await rollbackToPreOpReconciledAndThrow({
      syncParams: params.syncParams,
      checkoutDir: params.checkoutDir,
      absLedgerPath: params.absLedgerPath,
      baseState,
      remoteState,
      exceededStatus: postBucket,
    });
  }
  composeCumulativeIdRemap(params.cumulativeIdRemap, reconciled.idRemap);
  const nextLocalState: MemoryBranchLedgerState = {
    records: reconciled.records,
    meta: reconciled.meta,
  };
  const resetRes = await execGitCommand({
    cwd: params.checkoutDir,
    args: ['reset', '--hard', `origin/${branch}`],
  });
  if (resetRes.exitCode !== 0) {
    throw new MemoryHarnessError(
      'GIT_SYNC_FAILED',
      `Failed to reset '${params.checkoutDir}' to 'origin/${branch}' on retry ${params.attempt}: ${resetRes.stderr}`,
      {
        checkoutDir: params.checkoutDir,
        branch,
        attempt: params.attempt,
        stderr: resetRes.stderr,
      },
    );
  }
  await ensureMemoryGitignore(params.checkoutDir);
  await writeMemoryLedger({
    ledgerPath: params.absLedgerPath,
    records: nextLocalState.records,
    meta: nextLocalState.meta,
  });
  const reconcileCommitted = await stageAndCommitMemoryCheckout({
    checkoutDir: params.checkoutDir,
    relLedgerPath: params.relLedgerPath,
    relMetaPath: params.relMetaPath,
    commitMessage: `memory(${params.syncParams.config.repoId}): reconcile ${params.syncParams.opSummary}`,
  });
  if (!reconcileCommitted) {
    return { pushed: true, reconcileCommitted: false, nextLocalState };
  }
  const retryPush = await execGitCommand({
    cwd: params.checkoutDir,
    args: ['push', 'origin', branch],
  });
  return {
    pushed: retryPush.exitCode === 0,
    reconcileCommitted: true,
    nextLocalState,
  };
}

/**
 * Executes fallback-author auto-commit (§8.2.2), conflict-free 3-way diverged push retries
 * (`reconcileDivergedMemoryLedgers`), and pre-operation state rollback on post-push `CAP_EXCEEDED` (§8.2.3).
 *
 * @param {SyncMemoryGitParams} params - Workspace root, config, operation summary, and optional pre-op rollback state.
 *
 * @returns {Promise<SyncMemoryGitResult>} Commit/push flags, final ledger state, and cumulative ID remap.
 *
 * @throws {MemoryHarnessError} With `'CAP_EXCEEDED'` on post-reconcile capacity overflow or `'GIT_SYNC_FAILED'` after 3 push retry failures.
 */
export async function syncMemoryGit(params: SyncMemoryGitParams): Promise<SyncMemoryGitResult> {
  const absLedgerPath = path.resolve(params.workspaceRoot, params.config.storage.ledgerPath);
  const initialSnap = await readMemoryLedger(absLedgerPath, params.nowMs);
  if (!params.config.storage.git.enabled || !params.config.storage.git.autoCommit) {
    return Object.freeze<SyncMemoryGitResult>({
      gitCommitted: false,
      gitPushed: false,
      records: initialSnap.records,
      meta: initialSnap.meta,
      cumulativeIdRemap: new Map(),
      bucketStatusAfter: evaluateCandidateBucketAfter(params, initialSnap.records),
    });
  }
  const checkoutDir = path.resolve(params.workspaceRoot, params.config.storage.git.checkoutDir);
  const relLedgerPath = path.relative(checkoutDir, absLedgerPath).replaceAll('\\', '/');
  const relMetaPath = path.posix.join(path.posix.dirname(relLedgerPath), MEMORY_META_FILENAME);
  await ensureMemoryGitignore(checkoutDir);
  let gitCommitted = await stageAndCommitMemoryCheckout({
    checkoutDir,
    relLedgerPath,
    relMetaPath,
    commitMessage: `memory(${params.config.repoId}): ${params.opSummary}`,
  });
  const remoteUrl = params.config.storage.git.remoteUrl;
  if (!params.config.storage.git.autoPush || remoteUrl === undefined) {
    return Object.freeze<SyncMemoryGitResult>({
      gitCommitted,
      gitPushed: false,
      records: initialSnap.records,
      meta: initialSnap.meta,
      cumulativeIdRemap: new Map(),
      bucketStatusAfter: evaluateCandidateBucketAfter(params, initialSnap.records),
    });
  }
  await configureOriginRemote(checkoutDir, remoteUrl);
  const branch = params.config.storage.git.branch;
  const cumulativeIdRemap = new Map<string, string>();
  let currentLocalState: MemoryBranchLedgerState = {
    records: initialSnap.records,
    meta: initialSnap.meta,
  };
  const firstPush = await execGitCommand({
    cwd: checkoutDir,
    args: ['push', 'origin', branch],
  });
  if (firstPush.exitCode === 0) {
    return Object.freeze<SyncMemoryGitResult>({
      gitCommitted,
      gitPushed: true,
      records: currentLocalState.records,
      meta: currentLocalState.meta,
      cumulativeIdRemap,
      bucketStatusAfter: evaluateCandidateBucketAfter(params, currentLocalState.records),
    });
  }
  let gitPushed = false;
  for (let attempt = 1; attempt <= MAX_GIT_PUSH_RETRIES; attempt += 1) {
    const attemptOutcome = await executeSingleDivergedPushReconcileAttempt({
      syncParams: params,
      attempt,
      checkoutDir,
      absLedgerPath,
      relLedgerPath,
      relMetaPath,
      currentLocalState,
      cumulativeIdRemap,
    });
    currentLocalState = attemptOutcome.nextLocalState;
    if (attemptOutcome.reconcileCommitted) {
      gitCommitted = true;
    }
    if (attemptOutcome.pushed) {
      gitPushed = true;
      break;
    }
  }
  if (!gitPushed) {
    throw new MemoryHarnessError(
      'GIT_SYNC_FAILED',
      `Failed to push memory ledger to 'origin/${branch}' after ${MAX_GIT_PUSH_RETRIES} reconciliation retries.`,
      { checkoutDir, branch, retries: MAX_GIT_PUSH_RETRIES },
    );
  }
  return Object.freeze<SyncMemoryGitResult>({
    gitCommitted,
    gitPushed: true,
    records: currentLocalState.records,
    meta: currentLocalState.meta,
    cumulativeIdRemap,
    bucketStatusAfter: evaluateCandidateBucketAfter(params, currentLocalState.records),
  });
}
