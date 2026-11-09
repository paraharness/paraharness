import path from 'node:path';
import { withFileLock } from '@paraharness/lockfile';
import { MemoryHarnessError } from '../memory-harness-error.js';
import type { MemoryConfig } from '../schemas/memory-config.schema.js';
import type {
  MemoryNoteRecord,
  MemoryRecord,
} from '../schemas/memory-record.schema.js';
import {
  MemoryDrainNotesInputSchema,
  type DrainNoteModeSelector,
  type MemoryDrainNotesInput,
  type MemoryDrainNotesOutput,
} from '../schemas/memory-tools.schema.js';
import { assertAllowedRole } from './assert-allowed-role.js';
import { ensureMemoryGitCheckout } from './ensure-memory-git-checkout.js';
import { listRepoFiles } from './list-repo-files.js';
import { matchesContextScope } from './matches-context-scope.js';
import { normalizeMemoryPathArray } from './normalize-memory-path-pattern.js';
import { readMemoryLedger } from './read-memory-ledger.js';
import {
  applyIdRemapToRecordIds,
  composeCumulativeIdRemap,
} from './reconcile-diverged-memory-ledgers.js';
import { remapOtherSessionStatesAfterLockRelease } from './remap-other-session-states-after-lock-release.js';
import { isRecordActiveForRepo } from './resolve-record-cap-bucket.js';
import { syncMemoryGit } from './sync-memory-git.js';
import { writeMemoryLedger } from './write-memory-ledger.js';

/**
 * Parameter object for `executeMemoryDrainNotes`.
 */
export interface ExecuteMemoryDrainNotesParams {
  /** Absolute path to the workspace root directory. */
  readonly workspaceRoot: string;
  /** Validated unified memory configuration. */
  readonly config: MemoryConfig;
  /** Tool input payload (`callerRole`, `modes`, optional `role`/`paths`/`ids`, and `dryRun`). */
  readonly input: MemoryDrainNotesInput;
  /** Current UTC timestamp in epoch milliseconds. */
  readonly nowMs: number;
}

/**
 * Parameter object for `filterNotesForDrainage`.
 */
export interface FilterNotesForDrainageParams {
  /** Active records from `readMemoryLedger`. */
  readonly records: readonly MemoryRecord[];
  /** Active repository identifier from `config.repoId`. */
  readonly repoId: string;
  /** Selected note lifecycle modes (including `'*'` for all modes). */
  readonly modeSet: ReadonlySet<DrainNoteModeSelector>;
  /** Optional target role filter. */
  readonly roleFilter?: string;
  /** Optional normalized query paths filter. */
  readonly normalizedPaths?: readonly string[];
  /** Optional explicit note ID filter set. */
  readonly idFilterSet?: ReadonlySet<string>;
  /** Tracked workspace-relative POSIX file paths. */
  readonly repoFiles: readonly string[];
}

/**
 * Filters active `type: 'note'` records applicable to `repoId` against lifecycle mode, role, path,
 * and ID selectors, partitioning the ledger into `matchedNotes` and `remainingRecords` (§6.6 Step 2).
 *
 * @param {FilterNotesForDrainageParams} params - Active records and filter criteria.
 *
 * @returns {{ readonly matchedNotes: readonly MemoryNoteRecord[]; readonly remainingRecords: readonly MemoryRecord[] }} Matched notes and remaining untouched records.
 */
function filterNotesForDrainage(params: FilterNotesForDrainageParams): {
  readonly matchedNotes: readonly MemoryNoteRecord[];
  readonly remainingRecords: readonly MemoryRecord[];
} {
  const matchedNotes: MemoryNoteRecord[] = [];
  const remainingRecords: MemoryRecord[] = [];
  const matchAllModes = params.modeSet.has('*');
  for (const record of params.records) {
    if (record.type !== 'note' || !isRecordActiveForRepo(record, params.repoId)) {
      remainingRecords.push(record);
      continue;
    }
    const modeMatches = matchAllModes || params.modeSet.has(record.lifecycle.mode);
    const roleMatches = params.roleFilter === undefined || record.role === params.roleFilter;
    const pathMatches =
      params.normalizedPaths === undefined ||
      (record.context !== undefined &&
        matchesContextScope(params.normalizedPaths, record.context, params.repoFiles));
    const idMatches = params.idFilterSet === undefined || params.idFilterSet.has(record.id);
    if (modeMatches && roleMatches && pathMatches && idMatches) {
      matchedNotes.push(record);
      continue;
    }
    remainingRecords.push(record);
  }
  return Object.freeze({
    matchedNotes,
    remainingRecords,
  });
}

/**
 * Executes the `memory_drain_notes` tool contract (§6.6, §8.1): validates `callerRole`, optional
 * `role`, `modes`, and `paths`, acquires `<ledgerPath>.lock`, filters matching active notes, and
 * either returns a non-mutating preview (`dryRun: true`) or removes the matched notes, persists the
 * ledger in §8.1 Rule 2 order, and runs Git auto-commit/push (`dryRun: false`).
 *
 * @param {ExecuteMemoryDrainNotesParams} params - Workspace root, config, `MemoryDrainNotesInput`, and `nowMs`.
 *
 * @returns {Promise<MemoryDrainNotesOutput>} Validated `MemoryDrainNotesOutput` payload.
 *
 * @throws {MemoryHarnessError} With `'INVALID_ROLE'`, `'VALIDATION_FAILED'`, or `'GIT_SYNC_FAILED'`.
 */
export async function executeMemoryDrainNotes(
  params: ExecuteMemoryDrainNotesParams,
): Promise<MemoryDrainNotesOutput> {
  assertAllowedRole(params.input.callerRole, params.config.allowedRoles, 'callerRole');
  if (params.input.role !== undefined) {
    assertAllowedRole(params.input.role, params.config.allowedRoles, 'role');
  }
  const parsedSchema = MemoryDrainNotesInputSchema.safeParse(params.input);
  if (!parsedSchema.success) {
    throw new MemoryHarnessError(
      'VALIDATION_FAILED',
      `Invalid memory_drain_notes input: ${parsedSchema.error.message}`,
      { issues: parsedSchema.error.issues },
    );
  }
  const validatedInput = parsedSchema.data;
  const normalizedPaths =
    validatedInput.paths !== undefined
      ? normalizeMemoryPathArray(validatedInput.paths, params.workspaceRoot)
      : undefined;
  const repoFiles =
    normalizedPaths !== undefined ? await listRepoFiles(params.workspaceRoot) : [];
  const modeSet = new Set<DrainNoteModeSelector>(validatedInput.modes);
  const idFilterSet =
    validatedInput.ids !== undefined ? new Set<string>(validatedInput.ids) : undefined;
  const absLedgerPath = path.resolve(params.workspaceRoot, params.config.storage.ledgerPath);
  const ledgerLockPath = `${absLedgerPath}.lock`;
  const cumulativeIdRemap = new Map<string, string>();
  const drainOutcome = await withFileLock(ledgerLockPath, async () => {
    if (params.config.storage.git.enabled) {
      const checkoutOutcome = await ensureMemoryGitCheckout({
        workspaceRoot: params.workspaceRoot,
        config: params.config,
        isInitCall: false,
        nowMs: params.nowMs,
      });
      composeCumulativeIdRemap(cumulativeIdRemap, checkoutOutcome.cumulativeIdRemap);
    }
    const snapshot = await readMemoryLedger(absLedgerPath, params.nowMs);
    const filtered = filterNotesForDrainage({
      records: snapshot.records,
      repoId: params.config.repoId,
      modeSet,
      roleFilter: validatedInput.role,
      normalizedPaths,
      idFilterSet,
      repoFiles,
    });
    if (validatedInput.dryRun) {
      return Object.freeze<MemoryDrainNotesOutput>({
        dryRun: true,
        matchedNotes: [...filtered.matchedNotes],
        drainedIds: [],
        gitCommitted: false,
        gitPushed: false,
      });
    }
    const writeMeta = snapshot.metaNeedsWrite;
    const writeLedger = snapshot.ledgerNeedsWrite || filtered.matchedNotes.length > 0;
    let gitCommitted = false;
    let gitPushed = false;
    const syncRemap = new Map<string, string>();
    if (writeMeta || writeLedger) {
      await writeMemoryLedger({
        ledgerPath: absLedgerPath,
        records: filtered.remainingRecords,
        meta: snapshot.meta,
        writeMeta,
        writeLedger,
      });
      if (params.config.storage.git.enabled && params.config.storage.git.autoCommit) {
        const syncOutcome = await syncMemoryGit({
          workspaceRoot: params.workspaceRoot,
          config: params.config,
          opSummary: `drain ${filtered.matchedNotes.length} notes`,
          nowMs: params.nowMs,
        });
        gitCommitted = syncOutcome.gitCommitted;
        gitPushed = syncOutcome.gitPushed;
        composeCumulativeIdRemap(syncRemap, syncOutcome.cumulativeIdRemap);
        composeCumulativeIdRemap(cumulativeIdRemap, syncOutcome.cumulativeIdRemap);
      }
    }
    const rawDrainedIds: string[] = [];
    for (const note of filtered.matchedNotes) {
      rawDrainedIds.push(note.id);
    }
    const remappedDrainedIds = applyIdRemapToRecordIds(rawDrainedIds, syncRemap);
    return Object.freeze<MemoryDrainNotesOutput>({
      dryRun: false,
      matchedNotes: [...filtered.matchedNotes],
      drainedIds: [...remappedDrainedIds],
      gitCommitted,
      gitPushed,
    });
  });
  if (cumulativeIdRemap.size > 0) {
    await remapOtherSessionStatesAfterLockRelease(params.workspaceRoot, cumulativeIdRemap);
  }
  return drainOutcome;
}
