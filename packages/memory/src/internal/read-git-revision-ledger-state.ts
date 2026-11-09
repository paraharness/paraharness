import { MemoryMetaSchema, type MemoryMeta } from '../schemas/memory-record.schema.js';
import { createEmptyBranchLedgerState } from './create-empty-branch-ledger-state.js';
import { execGitCommand } from './exec-git-command.js';
import type { MemoryBranchLedgerState } from './memory-branch-ledger-state.js';
import { parseMemoryLedgerJsonl, reconcileMetaHighWaterMarks } from './read-memory-ledger.js';

/**
 * Parameter object for `readGitRevisionLedgerState`.
 */
export interface ReadGitRevisionLedgerStateParams {
  /** Absolute path to the `.memory` Git checkout directory. */
  readonly checkoutDir: string;
  /** Git commit SHA or ref name (or `null` for an empty base). */
  readonly gitRef: string | null;
  /** Checkout-relative POSIX path to `memory.jsonl`. */
  readonly relLedgerPath: string;
  /** Checkout-relative POSIX path to `memory.meta.json`. */
  readonly relMetaPath: string;
}

/**
 * Reads `<relLedgerPath>` and `<relMetaPath>` from a specific Git revision (`<gitRef>:<path>`)
 * inside `checkoutDir` without checking out that revision on disk (§8.2.3 Step 1).
 *
 * @param {ReadGitRevisionLedgerStateParams} params - Checkout directory, git ref, and relative ledger/meta paths.
 *
 * @returns {Promise<MemoryBranchLedgerState>} Parsed and reconciled ledger state at `params.gitRef`.
 */
export async function readGitRevisionLedgerState(
  params: ReadGitRevisionLedgerStateParams,
): Promise<MemoryBranchLedgerState> {
  if (params.gitRef === null || params.gitRef.length === 0) {
    return createEmptyBranchLedgerState();
  }
  const ledgerShow = await execGitCommand({
    cwd: params.checkoutDir,
    args: ['show', `${params.gitRef}:${params.relLedgerPath}`],
  });
  const records =
    ledgerShow.exitCode === 0
      ? parseMemoryLedgerJsonl(ledgerShow.stdout, `${params.gitRef}:${params.relLedgerPath}`)
      : Object.freeze([]);
  const metaShow = await execGitCommand({
    cwd: params.checkoutDir,
    args: ['show', `${params.gitRef}:${params.relMetaPath}`],
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
