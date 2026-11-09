import path from 'node:path';
import { MemoryHarnessError } from '../memory-harness-error.js';
import type { MemoryConfig } from '../schemas/memory-config.schema.js';
import type { MemoryMeta, MemoryRecord } from '../schemas/memory-record.schema.js';
import type { MemoryBucketStatus } from '../schemas/memory-tools.schema.js';
import { execGitCommand } from './exec-git-command.js';
import {
  configureOriginRemote,
  ensureMemoryGitignore,
  readGitRevisionLedgerState,
  stageAndCommitMemoryCheckout,
} from './git-checkout-helpers.js';
import { MAX_GIT_PUSH_RETRIES, MEMORY_META_FILENAME } from './memory-protocol.constants.js';
import { readMemoryLedger } from './read-memory-ledger.js';
import {
  composeCumulativeIdRemap,
  reconcileDivergedMemoryLedgers,
} from './reconcile-diverged-memory-ledgers.js';
import type { MemoryBranchLedgerState } from './reconciled-memory-ledger-result.js';
import {
  isRecordActiveForRepo,
  resolveRecordCapBucket,
  type CapCandidateRecord,
} from './resolve-record-cap-bucket.js';
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
  /** Result shape reference for single-root reachability (`Rule 1.2`). */
  readonly resultShape?: SyncMemoryGitResult;
}

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
 * @param {SyncMemoryGitParams}     params        - Sync parameters.
 * @param {string}                  checkoutDir   - Absolute path to `<checkoutDir>`.
 * @param {string}                  absLedgerPath - Absolute path to `<ledgerPath>`.
 * @param {MemoryBranchLedgerState} baseState     - Common ancestor state.
 * @param {MemoryBranchLedgerState} remoteState   - Remote `origin/<branch>` state.
 * @param {MemoryBucketStatus}      exceededStatus - Post-reconcile bucket status that violated the cap.
 *
 * @returns {Promise<never>} Always throws `MemoryHarnessError` with `'CAP_EXCEEDED'`.
 */
async function rollbackToPreOpReconciledAndThrow(
  params: SyncMemoryGitParams,
  checkoutDir: string,
  absLedgerPath: string,
  baseState: MemoryBranchLedgerState,
  remoteState: MemoryBranchLedgerState,
  exceededStatus: MemoryBucketStatus,
): Promise<never> {
  const branch = params.config.storage.git.branch;
  const relLedgerPath = path.relative(checkoutDir, absLedgerPath).replaceAll('\\', '/');
  const relMetaPath = path.posix.join(path.posix.dirname(relLedgerPath), MEMORY_META_FILENAME);
  const preOp = params.preOpSnapshot ?? baseState;
  const rollbackReconciled = reconcileDivergedMemoryLedgers(baseState, preOp, remoteState);
  await execGitCommand({
    cwd: checkoutDir,
    args: ['reset', '--hard', `origin/${branch}`],
  });
  await ensureMemoryGitignore(checkoutDir);
  await writeMemoryLedger({
    ledgerPath: absLedgerPath,
    records: rollbackReconciled.records,
    meta: rollbackReconciled.meta,
  });
  if (params.config.storage.git.autoCommit) {
    await stageAndCommitMemoryCheckout(
      checkoutDir,
      relLedgerPath,
      relMetaPath,
      `memory(${params.config.repoId}): reconcile pre-operation state`,
    );
  }
  throw new MemoryHarnessError(
    'CAP_EXCEEDED',
    `Capacity exceeded after reconciling with 'origin/${branch}' in bucket '${exceededStatus.bucketId}' (count ${exceededStatus.currentCount}, hardCap ${exceededStatus.hardCap ?? 'none'}, total ${exceededStatus.totalRecordsCount}/${exceededStatus.maxTotalRecords ?? 'unlimited'}).`,
    { bucketStatus: exceededStatus },
  );
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
  let gitCommitted = await stageAndCommitMemoryCheckout(
    checkoutDir,
    relLedgerPath,
    relMetaPath,
    `memory(${params.config.repoId}): ${params.opSummary}`,
  );
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
  let latestRecords = initialSnap.records;
  let latestMeta = initialSnap.meta;
  const firstPush = await execGitCommand({
    cwd: checkoutDir,
    args: ['push', 'origin', branch],
  });
  if (firstPush.exitCode === 0) {
    return Object.freeze<SyncMemoryGitResult>({
      gitCommitted,
      gitPushed: true,
      records: latestRecords,
      meta: latestMeta,
      cumulativeIdRemap,
      bucketStatusAfter: evaluateCandidateBucketAfter(params, latestRecords),
    });
  }
  let gitPushed = false;
  for (let attempt = 1; attempt <= MAX_GIT_PUSH_RETRIES; attempt += 1) {
    const fetchRes = await execGitCommand({
      cwd: checkoutDir,
      args: ['fetch', 'origin', branch],
    });
    if (fetchRes.exitCode !== 0) {
      throw new MemoryHarnessError(
        'GIT_SYNC_FAILED',
        `Failed to fetch 'origin/${branch}' during push retry ${attempt}: ${fetchRes.stderr}`,
        { checkoutDir, branch, attempt, stderr: fetchRes.stderr },
      );
    }
    const mergeBaseRes = await execGitCommand({
      cwd: checkoutDir,
      args: ['merge-base', 'HEAD', `origin/${branch}`],
    });
    const baseSha = mergeBaseRes.exitCode === 0 ? mergeBaseRes.stdout.trim() : null;
    const baseState = await readGitRevisionLedgerState(
      checkoutDir,
      baseSha,
      relLedgerPath,
      relMetaPath,
    );
    const remoteState = await readGitRevisionLedgerState(
      checkoutDir,
      `origin/${branch}`,
      relLedgerPath,
      relMetaPath,
    );
    const reconciled = reconcileDivergedMemoryLedgers(
      baseState,
      { records: latestRecords, meta: latestMeta },
      remoteState,
    );
    const postBucket = evaluateCandidateBucketAfter(params, reconciled.records);
    if (postBucket !== null) {
      const hardCapExceeded =
        postBucket.hardCap !== null && postBucket.currentCount > postBucket.hardCap;
      const totalExceeded =
        params.config.maxTotalRecords !== undefined &&
        postBucket.totalRecordsCount > params.config.maxTotalRecords;
      if (hardCapExceeded || totalExceeded) {
        await rollbackToPreOpReconciledAndThrow(
          params,
          checkoutDir,
          absLedgerPath,
          baseState,
          remoteState,
          postBucket,
        );
      }
    }
    composeCumulativeIdRemap(cumulativeIdRemap, reconciled.idRemap);
    latestRecords = reconciled.records;
    latestMeta = reconciled.meta;
    const resetRes = await execGitCommand({
      cwd: checkoutDir,
      args: ['reset', '--hard', `origin/${branch}`],
    });
    if (resetRes.exitCode !== 0) {
      throw new MemoryHarnessError(
        'GIT_SYNC_FAILED',
        `Failed to reset '${checkoutDir}' to 'origin/${branch}' on retry ${attempt}: ${resetRes.stderr}`,
        { checkoutDir, branch, attempt, stderr: resetRes.stderr },
      );
    }
    await ensureMemoryGitignore(checkoutDir);
    await writeMemoryLedger({
      ledgerPath: absLedgerPath,
      records: latestRecords,
      meta: latestMeta,
    });
    const reconcileCommitted = await stageAndCommitMemoryCheckout(
      checkoutDir,
      relLedgerPath,
      relMetaPath,
      `memory(${params.config.repoId}): reconcile ${params.opSummary}`,
    );
    if (!reconcileCommitted) {
      gitPushed = true;
      break;
    }
    gitCommitted = true;
    const retryPush = await execGitCommand({
      cwd: checkoutDir,
      args: ['push', 'origin', branch],
    });
    if (retryPush.exitCode === 0) {
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
    records: latestRecords,
    meta: latestMeta,
    cumulativeIdRemap,
    bucketStatusAfter: evaluateCandidateBucketAfter(params, latestRecords),
  });
}
