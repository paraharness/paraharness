import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { MemoryHarnessError } from '../memory-harness-error.js';
import type { MemoryConfig } from '../schemas/memory-config.schema.js';
import { execGitCommand } from './exec-git-command.js';
import {
  configureOriginRemote,
  createEmptyBranchLedgerState,
  ensureMemoryGitignore,
  readGitRevisionLedgerState,
} from './git-checkout-helpers.js';
import { MEMORY_META_FILENAME } from './memory-protocol.constants.js';
import { readMemoryLedger } from './read-memory-ledger.js';
import {
  composeCumulativeIdRemap,
  reconcileDivergedMemoryLedgers,
} from './reconcile-diverged-memory-ledgers.js';
import { syncMemoryGit } from './sync-memory-git.js';
import { writeMemoryLedger } from './write-memory-ledger.js';

/**
 * Parameter object for `ensureMemoryGitCheckout`.
 */
export interface EnsureMemoryGitCheckoutParams {
  /** Absolute path to the workspace root directory. */
  readonly workspaceRoot: string;
  /** Validated unified memory configuration. */
  readonly config: MemoryConfig;
  /** Whether the caller is `memory_init` (enabling best-effort `autoPullOnInit` reconciliation). */
  readonly isInitCall?: boolean;
  /** Optional UTC timestamp override in epoch milliseconds. */
  readonly nowMs?: number;
  /** Result shape reference for single-root reachability (`Rule 1.2`). */
  readonly resultShape?: EnsureMemoryGitCheckoutResult;
}

/**
 * Result returned by `ensureMemoryGitCheckout` (§8.2.1).
 */
export interface EnsureMemoryGitCheckoutResult {
  /** Whether a new `.git` repository was initialized in `<checkoutDir>`. */
  readonly initializedNewGitRepo: boolean;
  /** Whether local records were reconciled with `origin/<branch>`. */
  readonly reconciledWithRemote: boolean;
  /** Whether a Git commit was created during initialization/reconciliation. */
  readonly gitCommitted: boolean;
  /** Whether commits were pushed to `origin/<branch>` during initialization/reconciliation. */
  readonly gitPushed: boolean;
  /** Cumulative ID remapping (`oldId -> newId`) produced by any 3-way reconciliation. */
  readonly cumulativeIdRemap: ReadonlyMap<string, string>;
}

/**
 * Initializes `<checkoutDir>` in-place when `<checkoutDir>/.git` does not yet exist and reconciles
 * any pre-existing local ledger against `origin/<branch>` (§8.2.1 Step 1).
 *
 * @param {EnsureMemoryGitCheckoutParams} params        - Workspace root, config, and clock options.
 * @param {string}                        checkoutDir   - Absolute path to `<checkoutDir>`.
 * @param {string}                        absLedgerPath - Absolute path to `<ledgerPath>`.
 *
 * @returns {Promise<EnsureMemoryGitCheckoutResult>} Initialization and remote attach result.
 */
async function initializeFreshGitCheckout(
  params: EnsureMemoryGitCheckoutParams,
  checkoutDir: string,
  absLedgerPath: string,
): Promise<EnsureMemoryGitCheckoutResult> {
  const branch = params.config.storage.git.branch;
  const initRes = await execGitCommand({
    cwd: checkoutDir,
    useDashC: false,
    args: ['init', '-b', branch, checkoutDir],
  });
  if (initRes.exitCode !== 0) {
    throw new MemoryHarnessError(
      'GIT_SYNC_FAILED',
      `Failed to initialize git checkout at '${checkoutDir}': ${initRes.stderr}`,
      { checkoutDir, stderr: initRes.stderr },
    );
  }
  await ensureMemoryGitignore(checkoutDir);
  const cumulativeIdRemap = new Map<string, string>();
  let reconciledWithRemote = false;
  let gitCommitted = false;
  let gitPushed = false;
  const remoteUrl = params.config.storage.git.remoteUrl;
  if (remoteUrl !== undefined) {
    await configureOriginRemote(checkoutDir, remoteUrl);
    const lsRemote = await execGitCommand({
      cwd: checkoutDir,
      args: ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`],
    });
    if (lsRemote.exitCode !== 0) {
      throw new MemoryHarnessError(
        'GIT_SYNC_FAILED',
        `Failed to query ls-remote on '${remoteUrl}' for branch '${branch}': ${lsRemote.stderr}`,
        { checkoutDir, remoteUrl, branch, stderr: lsRemote.stderr },
      );
    }
    if (lsRemote.stdout.trim().length > 0) {
      const hadLocalLedger = existsSync(absLedgerPath);
      const localSnap = hadLocalLedger
        ? await readMemoryLedger(absLedgerPath, params.nowMs)
        : null;
      const fetchRes = await execGitCommand({
        cwd: checkoutDir,
        args: ['fetch', 'origin', branch],
      });
      if (fetchRes.exitCode !== 0) {
        throw new MemoryHarnessError(
          'GIT_SYNC_FAILED',
          `Failed to fetch 'origin/${branch}' in '${checkoutDir}': ${fetchRes.stderr}`,
          { checkoutDir, branch, stderr: fetchRes.stderr },
        );
      }
      const resetRes = await execGitCommand({
        cwd: checkoutDir,
        args: ['reset', '--hard', `origin/${branch}`],
      });
      if (resetRes.exitCode !== 0) {
        throw new MemoryHarnessError(
          'GIT_SYNC_FAILED',
          `Failed to reset '${checkoutDir}' to 'origin/${branch}': ${resetRes.stderr}`,
          { checkoutDir, branch, stderr: resetRes.stderr },
        );
      }
      await ensureMemoryGitignore(checkoutDir);
      if (localSnap !== null) {
        const remoteSnap = await readMemoryLedger(absLedgerPath, params.nowMs);
        const reconciled = reconcileDivergedMemoryLedgers(
          createEmptyBranchLedgerState(),
          { records: localSnap.records, meta: localSnap.meta },
          { records: remoteSnap.records, meta: remoteSnap.meta },
        );
        composeCumulativeIdRemap(cumulativeIdRemap, reconciled.idRemap);
        await writeMemoryLedger({
          ledgerPath: absLedgerPath,
          records: reconciled.records,
          meta: reconciled.meta,
        });
        reconciledWithRemote = true;
        if (params.config.storage.git.autoCommit) {
          const syncRes = await syncMemoryGit({
            workspaceRoot: params.workspaceRoot,
            config: params.config,
            opSummary: 'reconcile initial local ledger with remote',
            nowMs: params.nowMs,
          });
          composeCumulativeIdRemap(cumulativeIdRemap, syncRes.cumulativeIdRemap);
          gitCommitted = syncRes.gitCommitted;
          gitPushed = syncRes.gitPushed;
        }
      }
    }
  }
  await ensureMemoryGitignore(checkoutDir);
  return Object.freeze<EnsureMemoryGitCheckoutResult>({
    initializedNewGitRepo: true,
    reconciledWithRemote,
    gitCommitted,
    gitPushed,
    cumulativeIdRemap,
  });
}

/**
 * Executes best-effort `autoPullOnInit` remote fetch and 3-way reconciliation on `memory_init`
 * when `<checkoutDir>/.git` already exists (§8.2.1 Step 1).
 *
 * @param {EnsureMemoryGitCheckoutParams} params        - Workspace root, config, and clock options.
 * @param {string}                        checkoutDir   - Absolute path to `<checkoutDir>`.
 * @param {string}                        absLedgerPath - Absolute path to `<ledgerPath>`.
 *
 * @returns {Promise<EnsureMemoryGitCheckoutResult>} Pull and reconciliation outcome.
 */
async function pullAndReconcileExistingCheckoutOnInit(
  params: EnsureMemoryGitCheckoutParams,
  checkoutDir: string,
  absLedgerPath: string,
): Promise<EnsureMemoryGitCheckoutResult> {
  const remoteUrl = params.config.storage.git.remoteUrl;
  const branch = params.config.storage.git.branch;
  if (remoteUrl === undefined) {
    return Object.freeze<EnsureMemoryGitCheckoutResult>({
      initializedNewGitRepo: false,
      reconciledWithRemote: false,
      gitCommitted: false,
      gitPushed: false,
      cumulativeIdRemap: new Map(),
    });
  }
  await configureOriginRemote(checkoutDir, remoteUrl);
  const fetchRes = await execGitCommand({
    cwd: checkoutDir,
    args: ['fetch', 'origin', branch],
  });
  if (fetchRes.exitCode !== 0) {
    return Object.freeze<EnsureMemoryGitCheckoutResult>({
      initializedNewGitRepo: false,
      reconciledWithRemote: false,
      gitCommitted: false,
      gitPushed: false,
      cumulativeIdRemap: new Map(),
    });
  }
  const verifyRemoteRef = await execGitCommand({
    cwd: checkoutDir,
    args: ['rev-parse', '--verify', `refs/remotes/origin/${branch}`],
  });
  if (verifyRemoteRef.exitCode !== 0) {
    return Object.freeze<EnsureMemoryGitCheckoutResult>({
      initializedNewGitRepo: false,
      reconciledWithRemote: false,
      gitCommitted: false,
      gitPushed: false,
      cumulativeIdRemap: new Map(),
    });
  }
  const isAncestor = await execGitCommand({
    cwd: checkoutDir,
    args: ['merge-base', '--is-ancestor', `origin/${branch}`, 'HEAD'],
  });
  if (isAncestor.exitCode === 0) {
    return Object.freeze<EnsureMemoryGitCheckoutResult>({
      initializedNewGitRepo: false,
      reconciledWithRemote: false,
      gitCommitted: false,
      gitPushed: false,
      cumulativeIdRemap: new Map(),
    });
  }
  const relLedgerPath = path.relative(checkoutDir, absLedgerPath).replaceAll('\\', '/');
  const relMetaPath = path.posix.join(path.posix.dirname(relLedgerPath), MEMORY_META_FILENAME);
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
  const localSnap = await readMemoryLedger(absLedgerPath, params.nowMs);
  const remoteState = await readGitRevisionLedgerState(
    checkoutDir,
    `origin/${branch}`,
    relLedgerPath,
    relMetaPath,
  );
  const reconciled = reconcileDivergedMemoryLedgers(
    baseState,
    { records: localSnap.records, meta: localSnap.meta },
    remoteState,
  );
  const cumulativeIdRemap = new Map<string, string>();
  composeCumulativeIdRemap(cumulativeIdRemap, reconciled.idRemap);
  const resetRes = await execGitCommand({
    cwd: checkoutDir,
    args: ['reset', '--hard', `origin/${branch}`],
  });
  if (resetRes.exitCode !== 0) {
    throw new MemoryHarnessError(
      'GIT_SYNC_FAILED',
      `Failed to reset '${checkoutDir}' to 'origin/${branch}' during init pull: ${resetRes.stderr}`,
      { checkoutDir, branch, stderr: resetRes.stderr },
    );
  }
  await ensureMemoryGitignore(checkoutDir);
  await writeMemoryLedger({
    ledgerPath: absLedgerPath,
    records: reconciled.records,
    meta: reconciled.meta,
  });
  let gitCommitted = false;
  let gitPushed = false;
  if (params.config.storage.git.autoCommit) {
    const syncRes = await syncMemoryGit({
      workspaceRoot: params.workspaceRoot,
      config: params.config,
      opSummary: 'reconcile remote updates on init',
      nowMs: params.nowMs,
    });
    composeCumulativeIdRemap(cumulativeIdRemap, syncRes.cumulativeIdRemap);
    gitCommitted = syncRes.gitCommitted;
    gitPushed = syncRes.gitPushed;
  }
  return Object.freeze<EnsureMemoryGitCheckoutResult>({
    initializedNewGitRepo: false,
    reconciledWithRemote: true,
    gitCommitted,
    gitPushed,
    cumulativeIdRemap,
  });
}

/**
 * Ensures the `.memory` Git checkout is initialized in-place (preserving `.session-state/`,
 * `*.lock`, and `*.tmp*` in `.gitignore`), reconciles pre-existing local records on first remote
 * attach, and executes best-effort `autoPullOnInit` fetch+reconcile during `memory_init` (§8.2.1).
 *
 * @param {EnsureMemoryGitCheckoutParams} params - Workspace root, configuration, and `isInitCall` flag.
 *
 * @returns {Promise<EnsureMemoryGitCheckoutResult>} Checkout initialization and reconciliation status.
 *
 * @throws {MemoryHarnessError} With `'GIT_SYNC_FAILED'` if initial `git init` or `ls-remote` fails.
 */
export async function ensureMemoryGitCheckout(
  params: EnsureMemoryGitCheckoutParams,
): Promise<EnsureMemoryGitCheckoutResult> {
  if (!params.config.storage.git.enabled) {
    return Object.freeze<EnsureMemoryGitCheckoutResult>({
      initializedNewGitRepo: false,
      reconciledWithRemote: false,
      gitCommitted: false,
      gitPushed: false,
      cumulativeIdRemap: new Map(),
    });
  }
  const checkoutDir = path.resolve(params.workspaceRoot, params.config.storage.git.checkoutDir);
  const absLedgerPath = path.resolve(params.workspaceRoot, params.config.storage.ledgerPath);
  await mkdir(checkoutDir, { recursive: true });
  const gitDirExists = existsSync(path.join(checkoutDir, '.git'));
  if (!gitDirExists) {
    return initializeFreshGitCheckout(params, checkoutDir, absLedgerPath);
  }
  await ensureMemoryGitignore(checkoutDir);
  if (
    params.isInitCall === true &&
    params.config.storage.git.autoPullOnInit &&
    params.config.storage.git.remoteUrl !== undefined
  ) {
    return pullAndReconcileExistingCheckoutOnInit(params, checkoutDir, absLedgerPath);
  }
  return Object.freeze<EnsureMemoryGitCheckoutResult>({
    initializedNewGitRepo: false,
    reconciledWithRemote: false,
    gitCommitted: false,
    gitPushed: false,
    cumulativeIdRemap: new Map(),
  });
}
