import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import { MemoryHarnessError } from '../memory-harness-error.js';
import { MemoryMetaSchema, type MemoryMeta } from '../schemas/memory-record.schema.js';
import { execGitCommand } from './exec-git-command.js';
import {
  FALLBACK_GIT_AUTHOR_EMAIL,
  FALLBACK_GIT_AUTHOR_NAME,
  MEMORY_GITIGNORE_ENTRIES,
} from './memory-protocol.constants.js';
import { parseMemoryLedgerJsonl, reconcileMetaHighWaterMarks } from './read-memory-ledger.js';
import type { MemoryBranchLedgerState } from './reconciled-memory-ledger-result.js';

/**
 * Returns an empty `MemoryBranchLedgerState` (`records: []`, `highWaterMarks: { R: 0, L: 0, N: 0 }`).
 *
 * @returns {MemoryBranchLedgerState} Frozen empty branch ledger state.
 */
export function createEmptyBranchLedgerState(): MemoryBranchLedgerState {
  const emptyMeta: MemoryMeta = Object.freeze({
    schemaVersion: 1,
    highWaterMarks: Object.freeze({ R: 0, L: 0, N: 0 }),
  });
  return Object.freeze<MemoryBranchLedgerState>({
    records: Object.freeze([]),
    meta: emptyMeta,
  });
}

/**
 * Ensures `<checkoutDir>/.gitignore` exists and contains `.session-state/`, `*.lock`, and `*.tmp*` (§8.1 Rule 3).
 *
 * @param {string} checkoutDir - Absolute path to the `.memory` Git checkout directory.
 *
 * @returns {Promise<void>} Resolves once `<checkoutDir>/.gitignore` contains all required entries.
 */
export async function ensureMemoryGitignore(checkoutDir: string): Promise<void> {
  const gitignorePath = path.join(checkoutDir, '.gitignore');
  let existingText = '';
  if (existsSync(gitignorePath)) {
    existingText = await readFile(gitignorePath, 'utf8');
  }
  const existingLines = new Set(
    existingText
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
  const missingEntries: string[] = [];
  for (const requiredEntry of MEMORY_GITIGNORE_ENTRIES) {
    if (!existingLines.has(requiredEntry)) {
      missingEntries.push(requiredEntry);
    }
  }
  if (missingEntries.length === 0 && existsSync(gitignorePath)) {
    return;
  }
  const combinedLines = [...existingLines, ...missingEntries];
  const nextContent = `${combinedLines.join('\n')}\n`;
  await writeFileAtomic(gitignorePath, nextContent, { encoding: 'utf8' });
}

/**
 * Reads `<relLedgerPath>` and `<relMetaPath>` from a specific Git revision (`<gitRef>:<path>`)
 * inside `checkoutDir` without checking out that revision on disk (§8.2.3 Step 1).
 *
 * @param {string}        checkoutDir   - Absolute path to the `.memory` Git checkout directory.
 * @param {string | null} gitRef        - Git commit SHA or ref name (or `null` for an empty base).
 * @param {string}        relLedgerPath - Checkout-relative POSIX path to `memory.jsonl`.
 * @param {string}        relMetaPath   - Checkout-relative POSIX path to `memory.meta.json`.
 *
 * @returns {Promise<MemoryBranchLedgerState>} Parsed and reconciled ledger state at `gitRef`.
 */
export async function readGitRevisionLedgerState(
  checkoutDir: string,
  gitRef: string | null,
  relLedgerPath: string,
  relMetaPath: string,
): Promise<MemoryBranchLedgerState> {
  if (gitRef === null || gitRef.length === 0) {
    return createEmptyBranchLedgerState();
  }
  const ledgerShow = await execGitCommand({
    cwd: checkoutDir,
    args: ['show', `${gitRef}:${relLedgerPath}`],
  });
  const records =
    ledgerShow.exitCode === 0
      ? parseMemoryLedgerJsonl(ledgerShow.stdout, `${gitRef}:${relLedgerPath}`)
      : Object.freeze([]);
  const metaShow = await execGitCommand({
    cwd: checkoutDir,
    args: ['show', `${gitRef}:${relMetaPath}`],
  });
  let baseMeta: MemoryMeta = {
    schemaVersion: 1,
    highWaterMarks: { R: 0, L: 0, N: 0 },
  };
  if (metaShow.exitCode === 0 && metaShow.stdout.trim().length > 0) {
    try {
      const parsed = MemoryMetaSchema.safeParse(JSON.parse(metaShow.stdout));
      if (parsed.success) {
        baseMeta = parsed.data;
      }
    } catch {
      baseMeta = {
        schemaVersion: 1,
        highWaterMarks: { R: 0, L: 0, N: 0 },
      };
    }
  }
  const reconciledMeta = reconcileMetaHighWaterMarks(baseMeta, records);
  return Object.freeze<MemoryBranchLedgerState>({
    records,
    meta: reconciledMeta,
  });
}

/**
 * Stages `<relLedgerPath>`, `<relMetaPath>`, and `.gitignore` inside `checkoutDir` and creates a
 * commit with the fallback author identity if `git status --porcelain` is non-empty (§8.2.2).
 *
 * @param {string} checkoutDir   - Absolute path to the `.memory` Git checkout directory.
 * @param {string} relLedgerPath - Checkout-relative POSIX path to `memory.jsonl`.
 * @param {string} relMetaPath   - Checkout-relative POSIX path to `memory.meta.json`.
 * @param {string} commitMessage - Commit message (`"memory(<repoId>): <opSummary>"`).
 *
 * @returns {Promise<boolean>} `true` if a new commit was created; `false` if the staged tree was clean.
 *
 * @throws {MemoryHarnessError} With `'GIT_SYNC_FAILED'` if `git add` or `git commit` exits non-zero.
 */
export async function stageAndCommitMemoryCheckout(
  checkoutDir: string,
  relLedgerPath: string,
  relMetaPath: string,
  commitMessage: string,
): Promise<boolean> {
  const addRes = await execGitCommand({
    cwd: checkoutDir,
    args: ['add', '--', relLedgerPath, relMetaPath, '.gitignore'],
  });
  if (addRes.exitCode !== 0) {
    throw new MemoryHarnessError(
      'GIT_SYNC_FAILED',
      `Failed to stage memory files in '${checkoutDir}': ${addRes.stderr}`,
      { checkoutDir, stderr: addRes.stderr },
    );
  }
  const statusRes = await execGitCommand({
    cwd: checkoutDir,
    args: ['status', '--porcelain', '--', relLedgerPath, relMetaPath, '.gitignore'],
  });
  if (statusRes.exitCode !== 0) {
    throw new MemoryHarnessError(
      'GIT_SYNC_FAILED',
      `Failed to inspect git status in '${checkoutDir}': ${statusRes.stderr}`,
      { checkoutDir, stderr: statusRes.stderr },
    );
  }
  if (statusRes.stdout.trim().length === 0) {
    return false;
  }
  const commitRes = await execGitCommand({
    cwd: checkoutDir,
    args: [
      '-c',
      `user.name=${FALLBACK_GIT_AUTHOR_NAME}`,
      '-c',
      `user.email=${FALLBACK_GIT_AUTHOR_EMAIL}`,
      'commit',
      '-m',
      commitMessage,
    ],
  });
  if (commitRes.exitCode !== 0) {
    throw new MemoryHarnessError(
      'GIT_SYNC_FAILED',
      `Failed to commit memory ledger in '${checkoutDir}': ${commitRes.stderr}`,
      { checkoutDir, stderr: commitRes.stderr },
    );
  }
  return true;
}

/**
 * Configures the `origin` remote URL inside `checkoutDir` (`remote add` or `remote set-url`).
 *
 * @param {string} checkoutDir - Absolute path to the `.memory` Git checkout directory.
 * @param {string} remoteUrl   - Configured `storage.git.remoteUrl`.
 *
 * @returns {Promise<void>} Resolves once `origin` is configured to `remoteUrl`.
 *
 * @throws {MemoryHarnessError} With `'GIT_SYNC_FAILED'` if configuring `origin` fails.
 */
export async function configureOriginRemote(
  checkoutDir: string,
  remoteUrl: string,
): Promise<void> {
  const addRes = await execGitCommand({
    cwd: checkoutDir,
    args: ['remote', 'add', 'origin', remoteUrl],
  });
  if (addRes.exitCode === 0) {
    return;
  }
  const setRes = await execGitCommand({
    cwd: checkoutDir,
    args: ['remote', 'set-url', 'origin', remoteUrl],
  });
  if (setRes.exitCode !== 0) {
    throw new MemoryHarnessError(
      'GIT_SYNC_FAILED',
      `Failed to configure origin remote '${remoteUrl}' in '${checkoutDir}': ${setRes.stderr}`,
      { checkoutDir, remoteUrl, stderr: setRes.stderr },
    );
  }
}
