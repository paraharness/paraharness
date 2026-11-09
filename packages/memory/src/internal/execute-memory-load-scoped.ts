import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from '@paraharness/lockfile';
import { MemoryHarnessError } from '../memory-harness-error.js';
import type { MemoryConfig } from '../schemas/memory-config.schema.js';
import type {
  MemoryLessonRecord,
  MemoryRecord,
  MemoryRuleRecord,
} from '../schemas/memory-record.schema.js';
import {
  MemorySessionEpochStateSchema,
  type MemoryLoadedNoteRecord,
  type MemoryLoadScopedInput,
  type MemoryLoadScopedOutput,
  type MemorySessionEpochState,
} from '../schemas/memory-tools.schema.js';
import { assertAllowedRole } from './assert-allowed-role.js';
import { ensureMemoryGitCheckout } from './ensure-memory-git-checkout.js';
import { evaluateNoteLifecycleOnRead } from './evaluate-note-lifecycle-on-read.js';
import { listRepoFiles } from './list-repo-files.js';
import { matchesContextScope } from './matches-context-scope.js';
import {
  PENDING_HOOK_EPOCH,
  SESSION_STATE_REL_DIR,
} from './memory-protocol.constants.js';
import { normalizeMemoryPathArray } from './normalize-memory-path-pattern.js';
import { readMemoryLedger } from './read-memory-ledger.js';
import {
  applyIdRemapToRecordIds,
  composeCumulativeIdRemap,
} from './reconcile-diverged-memory-ledgers.js';
import { remapLoadedMemoryRecords } from './remap-loaded-memory-records.js';
import { remapOtherSessionStatesAfterLockRelease } from './remap-other-session-states-after-lock-release.js';
import { isRecordActiveForRepo } from './resolve-record-cap-bucket.js';
import { persistSessionEpochState } from './resolve-session-epoch-state.js';
import { resolveToolSessionId } from './resolve-tool-session-id.js';
import { syncMemoryGit } from './sync-memory-git.js';
import { writeMemoryLedger } from './write-memory-ledger.js';

/**
 * Parameter object for `executeMemoryLoadScoped`.
 */
export interface ExecuteMemoryLoadScopedParams {
  /** Absolute path to the workspace root directory. */
  readonly workspaceRoot: string;
  /** Validated unified memory configuration. */
  readonly config: MemoryConfig;
  /** Tool input payload (`role`, `paths`, and optional `sessionId`). */
  readonly input: MemoryLoadScopedInput;
  /** Current UTC timestamp in epoch milliseconds. */
  readonly nowMs: number;
}

/**
 * Parameter object for `selectScopedRecordsAndEvaluateNotes`.
 */
export interface SelectScopedRecordsParams {
  /** Canonically sorted active records from `readMemoryLedger`. */
  readonly records: readonly MemoryRecord[];
  /** Target session role name. */
  readonly role: string;
  /** Active repository identifier from `config.repoId`. */
  readonly repoId: string;
  /** Normalized query paths/globs `Q`. */
  readonly normalizedPaths: readonly string[];
  /** Tracked workspace-relative POSIX file paths `repoFiles`. */
  readonly repoFiles: readonly string[];
  /** Current UTC timestamp in epoch milliseconds. */
  readonly nowMs: number;
}

/**
 * Parameter object for `runLoadScopedLedgerSectionUnderLock`.
 */
export interface RunLoadScopedLedgerSectionParams {
  /** Absolute path to the workspace root directory. */
  readonly workspaceRoot: string;
  /** Validated unified memory configuration. */
  readonly config: MemoryConfig;
  /** Target role name. */
  readonly role: string;
  /** Normalized query paths/globs. */
  readonly normalizedPaths: readonly string[];
  /** Tracked workspace-relative POSIX file paths. */
  readonly repoFiles: readonly string[];
  /** Current UTC timestamp in epoch milliseconds. */
  readonly nowMs: number;
  /** Mutable cumulative ID remap updated in-place on Git reconciliation. */
  readonly cumulativeIdRemap: Map<string, string>;
}

/**
 * Selects all scoped records (`record.context !== undefined && record.context.length > 0`) matching
 * `role`, `repoId`, and `normalizedPaths`, and evaluates §3.3 lifecycle transitions on matched notes (§6.3 Step 3).
 *
 * @param {SelectScopedRecordsParams} params - Active records, role, repoId, normalized paths, `repoFiles`, and `nowMs`.
 *
 * @returns {{ readonly rules: readonly MemoryRuleRecord[]; readonly lessons: readonly MemoryLessonRecord[]; readonly notes: readonly MemoryLoadedNoteRecord[]; readonly retainedRecords: readonly MemoryRecord[]; readonly notesMutated: boolean }} Matched scoped records, retained ledger records, and mutation flag.
 */
function selectScopedRecordsAndEvaluateNotes(params: SelectScopedRecordsParams): {
  readonly rules: readonly MemoryRuleRecord[];
  readonly lessons: readonly MemoryLessonRecord[];
  readonly notes: readonly MemoryLoadedNoteRecord[];
  readonly retainedRecords: readonly MemoryRecord[];
  readonly notesMutated: boolean;
} {
  const rules: MemoryRuleRecord[] = [];
  const lessons: MemoryLessonRecord[] = [];
  const notes: MemoryLoadedNoteRecord[] = [];
  const retainedRecords: MemoryRecord[] = [];
  let notesMutated = false;
  for (const record of params.records) {
    const isScopedMatch =
      record.context !== undefined &&
      record.context.length > 0 &&
      (record.role === 'general' || record.role === params.role) &&
      isRecordActiveForRepo(record, params.repoId) &&
      matchesContextScope(params.normalizedPaths, record.context, params.repoFiles);
    if (!isScopedMatch) {
      retainedRecords.push(record);
      continue;
    }
    if (record.type === 'rule') {
      rules.push(record);
      retainedRecords.push(record);
      continue;
    }
    if (record.type === 'lesson') {
      lessons.push(record);
      retainedRecords.push(record);
      continue;
    }
    const lifecycleOutcome = evaluateNoteLifecycleOnRead(record, params.nowMs);
    if (lifecycleOutcome.loadedNote !== null) {
      notes.push(lifecycleOutcome.loadedNote);
    }
    if (lifecycleOutcome.retainedNote !== null) {
      retainedRecords.push(lifecycleOutcome.retainedNote);
    }
    if (lifecycleOutcome.mutatedLedger) {
      notesMutated = true;
    }
  }
  return Object.freeze({
    rules,
    lessons,
    notes,
    retainedRecords,
    notesMutated,
  });
}

/**
 * Executes the `<ledgerPath>.lock` critical section for `memory_load_scoped` (`isInitCall: false`),
 * reading the ledger, matching scoped records, persisting lifecycle mutations in §8.1 Rule 2 order,
 * and running Git auto-commit/push (§6.3 Step 3).
 *
 * @param {RunLoadScopedLedgerSectionParams} params - Workspace root, config, role, normalized paths, `repoFiles`, clock, and cumulative ID remap.
 *
 * @returns {Promise<{ readonly rules: readonly MemoryRuleRecord[]; readonly lessons: readonly MemoryLessonRecord[]; readonly notes: readonly MemoryLoadedNoteRecord[] }>} Matched scoped rules, lessons, and notes.
 */
function runLoadScopedLedgerSectionUnderLock(params: RunLoadScopedLedgerSectionParams): Promise<{
  readonly rules: readonly MemoryRuleRecord[];
  readonly lessons: readonly MemoryLessonRecord[];
  readonly notes: readonly MemoryLoadedNoteRecord[];
}> {
  const absLedgerPath = path.resolve(params.workspaceRoot, params.config.storage.ledgerPath);
  const ledgerLockPath = `${absLedgerPath}.lock`;
  return withFileLock(ledgerLockPath, async () => {
    if (params.config.storage.git.enabled) {
      const checkoutOutcome = await ensureMemoryGitCheckout({
        workspaceRoot: params.workspaceRoot,
        config: params.config,
        isInitCall: false,
        nowMs: params.nowMs,
      });
      composeCumulativeIdRemap(params.cumulativeIdRemap, checkoutOutcome.cumulativeIdRemap);
    }
    const snapshot = await readMemoryLedger(absLedgerPath, params.nowMs);
    const selection = selectScopedRecordsAndEvaluateNotes({
      records: snapshot.records,
      role: params.role,
      repoId: params.config.repoId,
      normalizedPaths: params.normalizedPaths,
      repoFiles: params.repoFiles,
      nowMs: params.nowMs,
    });
    const writeMeta = snapshot.metaNeedsWrite;
    const writeLedger = snapshot.ledgerNeedsWrite || selection.notesMutated;
    const syncRemap = new Map<string, string>();
    if (writeMeta || writeLedger) {
      await writeMemoryLedger({
        ledgerPath: absLedgerPath,
        records: selection.retainedRecords,
        meta: snapshot.meta,
        writeMeta,
        writeLedger,
      });
      if (params.config.storage.git.enabled && params.config.storage.git.autoCommit) {
        const syncOutcome = await syncMemoryGit({
          workspaceRoot: params.workspaceRoot,
          config: params.config,
          opSummary: `load_scoped(${params.role}) note lifecycle update`,
          nowMs: params.nowMs,
        });
        composeCumulativeIdRemap(syncRemap, syncOutcome.cumulativeIdRemap);
        composeCumulativeIdRemap(params.cumulativeIdRemap, syncOutcome.cumulativeIdRemap);
      }
    }
    return remapLoadedMemoryRecords({
      rules: selection.rules,
      lessons: selection.lessons,
      notes: selection.notes,
      idRemap: syncRemap,
    });
  });
}

/**
 * Parameter object for `updateSessionSeenIdsAfterScopedLoad`.
 */
export interface UpdateSessionSeenIdsParams {
  /** Absolute path to the workspace root directory. */
  readonly workspaceRoot: string;
  /** Validated session identifier. */
  readonly sessionId: string;
  /** Active session role name. */
  readonly role: string;
  /** Scoped record IDs returned on this call. */
  readonly returnedRecordIds: readonly string[];
  /** Cumulative ID remap from Git reconciliation. */
  readonly cumulativeIdRemap: ReadonlyMap<string, string>;
  /** Current UTC timestamp in ISO-8601 format. */
  readonly nowIso: string;
}

/**
 * Merges newly loaded scoped record IDs into `.memory/.session-state/<sessionId>.json` while holding
 * `<sessionId>.lock` (Step 4 of the §8.1 Rule 2 write sequence).
 *
 * @param {UpdateSessionSeenIdsParams} params - Workspace root, session ID, role, returned IDs, remap, and ISO timestamp.
 *
 * @returns {Promise<void>} Resolves once `<sessionId>.json` is atomically persisted.
 */
async function updateSessionSeenIdsAfterScopedLoad(
  params: UpdateSessionSeenIdsParams,
): Promise<void> {
  const statePath = path.resolve(
    params.workspaceRoot,
    SESSION_STATE_REL_DIR,
    `${params.sessionId}.json`,
  );
  let existingState: MemorySessionEpochState | undefined;
  if (existsSync(statePath)) {
    try {
      const parsed = MemorySessionEpochStateSchema.safeParse(
        JSON.parse(readFileSync(statePath, 'utf8')),
      );
      if (parsed.success) {
        existingState = parsed.data;
      }
    } catch {
      existingState = undefined;
    }
  }
  const baseSeenIds =
    existingState !== undefined
      ? applyIdRemapToRecordIds(existingState.seenRecordIds, params.cumulativeIdRemap)
      : [];
  const seenSet = new Set<string>(baseSeenIds);
  const mergedSeenIds: string[] = [...baseSeenIds];
  for (const id of params.returnedRecordIds) {
    if (!seenSet.has(id)) {
      seenSet.add(id);
      mergedSeenIds.push(id);
    }
  }
  const nextSessionState: MemorySessionEpochState = Object.freeze({
    sessionId: params.sessionId,
    role: params.role,
    lastCompactionCheckpointId: existingState?.lastCompactionCheckpointId ?? PENDING_HOOK_EPOCH,
    seenRecordIds: mergedSeenIds,
    lastScannedTranscriptOffset: existingState?.lastScannedTranscriptOffset ?? 0,
    transcriptPath: existingState?.transcriptPath,
    updatedAt: params.nowIso,
  });
  await persistSessionEpochState(params.workspaceRoot, nextSessionState);
}

/**
 * Executes the `memory_load_scoped` tool contract (§6.3, §8.1): validates `role`, `paths`, and
 * `sessionId`, acquires `<sessionId>.lock` first and `<ledgerPath>.lock` second, matches scoped
 * records via `matchesContextScope`, evaluates note lifecycles, updates `seenRecordIds` in
 * `<sessionId>.json`, and returns ordered scoped memories.
 *
 * @param {ExecuteMemoryLoadScopedParams} params - Workspace root, config, `MemoryLoadScopedInput`, and `nowMs`.
 *
 * @returns {Promise<MemoryLoadScopedOutput>} Validated `MemoryLoadScopedOutput` payload.
 *
 * @throws {MemoryHarnessError} With `'INVALID_ROLE'`, `'VALIDATION_FAILED'`, or `'GIT_SYNC_FAILED'`.
 */
export async function executeMemoryLoadScoped(
  params: ExecuteMemoryLoadScopedParams,
): Promise<MemoryLoadScopedOutput> {
  assertAllowedRole(params.input.role, params.config.allowedRoles);
  if (!Array.isArray(params.input.paths) || params.input.paths.length === 0) {
    throw new MemoryHarnessError(
      'VALIDATION_FAILED',
      'memory_load_scoped requires a non-empty paths array.',
      { paths: params.input.paths },
    );
  }
  const normalizedPaths = normalizeMemoryPathArray(params.input.paths, params.workspaceRoot);
  const sessionId = resolveToolSessionId(params.input.sessionId);
  const repoFiles = await listRepoFiles(params.workspaceRoot);
  const nowIso = new Date(params.nowMs).toISOString();
  const cumulativeIdRemap = new Map<string, string>();
  let loadedRecords: {
    readonly rules: readonly MemoryRuleRecord[];
    readonly lessons: readonly MemoryLessonRecord[];
    readonly notes: readonly MemoryLoadedNoteRecord[];
  };
  if (sessionId !== undefined) {
    const sessionStateDir = path.resolve(params.workspaceRoot, SESSION_STATE_REL_DIR);
    await mkdir(sessionStateDir, { recursive: true });
    const sessionLockPath = path.join(sessionStateDir, `${sessionId}.lock`);
    loadedRecords = await withFileLock(sessionLockPath, async () => {
      const ledgerOutcome = await runLoadScopedLedgerSectionUnderLock({
        workspaceRoot: params.workspaceRoot,
        config: params.config,
        role: params.input.role,
        normalizedPaths,
        repoFiles,
        nowMs: params.nowMs,
        cumulativeIdRemap,
      });
      const returnedIds: string[] = [];
      for (const rule of ledgerOutcome.rules) returnedIds.push(rule.id);
      for (const lesson of ledgerOutcome.lessons) returnedIds.push(lesson.id);
      for (const note of ledgerOutcome.notes) returnedIds.push(note.id);
      await updateSessionSeenIdsAfterScopedLoad({
        workspaceRoot: params.workspaceRoot,
        sessionId,
        role: params.input.role,
        returnedRecordIds: returnedIds,
        cumulativeIdRemap,
        nowIso,
      });
      return ledgerOutcome;
    });
  } else {
    loadedRecords = await runLoadScopedLedgerSectionUnderLock({
      workspaceRoot: params.workspaceRoot,
      config: params.config,
      role: params.input.role,
      normalizedPaths,
      repoFiles,
      nowMs: params.nowMs,
      cumulativeIdRemap,
    });
  }
  if (cumulativeIdRemap.size > 0) {
    await remapOtherSessionStatesAfterLockRelease(
      params.workspaceRoot,
      cumulativeIdRemap,
      sessionId,
    );
  }
  return Object.freeze<MemoryLoadScopedOutput>({
    role: params.input.role,
    normalizedPaths: [...normalizedPaths],
    rules: [...loadedRecords.rules],
    lessons: [...loadedRecords.lessons],
    notes: [...loadedRecords.notes],
  });
}
