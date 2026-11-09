import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from '@paraharness/lockfile';
import writeFileAtomic from 'write-file-atomic';
import type { MemoryConfig } from '../schemas/memory-config.schema.js';
import type {
  MemoryLessonRecord,
  MemoryRecord,
  MemoryRuleRecord,
} from '../schemas/memory-record.schema.js';
import {
  MemoryLatestRoleStateSchema,
  MemorySessionEpochStateSchema,
  type MemoryInitInput,
  type MemoryInitOutput,
  type MemoryLoadedNoteRecord,
  type MemorySessionEpochState,
} from '../schemas/memory-tools.schema.js';
import { assertAllowedRole } from './assert-allowed-role.js';
import { buildMemoryProtocol } from './build-memory-protocol.js';
import { ensureMemoryGitCheckout } from './ensure-memory-git-checkout.js';
import { evaluateNoteLifecycleOnRead } from './evaluate-note-lifecycle-on-read.js';
import {
  LATEST_ROLE_FILENAME,
  LATEST_ROLE_LOCK_FILENAME,
  PENDING_HOOK_EPOCH,
  SESSION_STATE_REL_DIR,
} from './memory-protocol.constants.js';
import { readMemoryLedger } from './read-memory-ledger.js';
import { composeCumulativeIdRemap } from './reconcile-diverged-memory-ledgers.js';
import { remapLoadedMemoryRecords } from './remap-loaded-memory-records.js';
import { remapOtherSessionStatesAfterLockRelease } from './remap-other-session-states-after-lock-release.js';
import { isRecordActiveForRepo } from './resolve-record-cap-bucket.js';
import { persistSessionEpochState } from './resolve-session-epoch-state.js';
import { resolveToolSessionId } from './resolve-tool-session-id.js';
import { syncMemoryGit } from './sync-memory-git.js';
import { writeMemoryLedger } from './write-memory-ledger.js';

/**
 * Parameter object for `executeMemoryInit`.
 */
export interface ExecuteMemoryInitParams {
  /** Absolute path to the workspace root directory. */
  readonly workspaceRoot: string;
  /** Validated unified memory configuration. */
  readonly config: MemoryConfig;
  /** Tool input payload (`role` and optional `sessionId`). */
  readonly input: MemoryInitInput;
  /** Current UTC timestamp in epoch milliseconds. */
  readonly nowMs: number;
}

/**
 * Parameter object for `runInitLedgerSectionUnderLock`.
 */
export interface RunInitLedgerSectionParams {
  /** Absolute path to the workspace root directory. */
  readonly workspaceRoot: string;
  /** Validated unified memory configuration. */
  readonly config: MemoryConfig;
  /** Active role passed to `memory_init`. */
  readonly role: string;
  /** Current UTC timestamp in epoch milliseconds. */
  readonly nowMs: number;
  /** Mutable cumulative ID remap updated in-place on Git reconciliation. */
  readonly cumulativeIdRemap: Map<string, string>;
}

/**
 * Acquires `.memory/.session-state/latest-role.lock`, atomically writes `.memory/.session-state/latest-role.json`,
 * and releases `latest-role.lock` before any `<sessionId>.lock` or `<ledgerPath>.lock` acquisition (§6.2 Step 2, §8.1 Rule 1).
 *
 * @param {string} workspaceRoot - Absolute path to the workspace root directory.
 * @param {string} role          - Validated active role name.
 * @param {string} nowIso        - Current UTC timestamp in ISO-8601 format.
 *
 * @returns {Promise<void>} Resolves once `latest-role.json` is persisted and `latest-role.lock` is released.
 */
async function persistLatestRoleUnderLock(
  workspaceRoot: string,
  role: string,
  nowIso: string,
): Promise<void> {
  const sessionStateDir = path.resolve(workspaceRoot, SESSION_STATE_REL_DIR);
  await mkdir(sessionStateDir, { recursive: true });
  const latestRoleLockPath = path.join(sessionStateDir, LATEST_ROLE_LOCK_FILENAME);
  const latestRoleJsonPath = path.join(sessionStateDir, LATEST_ROLE_FILENAME);
  const payload = MemoryLatestRoleStateSchema.parse({
    role,
    updatedAt: nowIso,
  });
  await withFileLock(latestRoleLockPath, async () => {
    await writeFileAtomic(latestRoleJsonPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: 'utf8',
    });
  });
}

/**
 * Parameter object for `selectUnscopedRecordsAndEvaluateNotes`.
 */
export interface SelectUnscopedRecordsParams {
  /** Canonically sorted active records from `readMemoryLedger`. */
  readonly records: readonly MemoryRecord[];
  /** Active session role name. */
  readonly role: string;
  /** Active repository identifier from `config.repoId`. */
  readonly repoId: string;
  /** Current UTC timestamp in epoch milliseconds. */
  readonly nowMs: number;
}

/**
 * Evaluates unscoped records for `role` and `repoId`, applying §3.3 lifecycle transitions exclusively
 * to unscoped notes while leaving all path-scoped records untouched (§3.3 Invariant 1, §6.2 Step 3).
 *
 * @param {SelectUnscopedRecordsParams} params - Active records, role, repoId, and `nowMs`.
 *
 * @returns {{ readonly rules: readonly MemoryRuleRecord[]; readonly lessons: readonly MemoryLessonRecord[]; readonly notes: readonly MemoryLoadedNoteRecord[]; readonly retainedRecords: readonly MemoryRecord[]; readonly notesMutated: boolean }} Selected unscoped records, retained ledger records, and mutation flag.
 */
function selectUnscopedRecordsAndEvaluateNotes(params: SelectUnscopedRecordsParams): {
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
    const isUnscopedMatch =
      record.context === undefined &&
      (record.role === 'general' || record.role === params.role) &&
      isRecordActiveForRepo(record, params.repoId);
    if (!isUnscopedMatch) {
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
 * Executes the `<ledgerPath>.lock` critical section for `memory_init`: initializes/pulls the Git
 * checkout (`isInitCall: true`), reads the ledger, evaluates unscoped notes, writes `memory.meta.json`
 * and `memory.jsonl` in §8.1 Rule 2 order, and runs Git auto-commit/push (§6.2 Step 3).
 *
 * @param {RunInitLedgerSectionParams} params - Workspace root, config, role, clock, and cumulative ID remap.
 *
 * @returns {Promise<{ readonly rules: readonly MemoryRuleRecord[]; readonly lessons: readonly MemoryLessonRecord[]; readonly notes: readonly MemoryLoadedNoteRecord[] }>} Loaded unscoped rules, lessons, and notes.
 */
function runInitLedgerSectionUnderLock(params: RunInitLedgerSectionParams): Promise<{
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
        isInitCall: true,
        nowMs: params.nowMs,
      });
      composeCumulativeIdRemap(params.cumulativeIdRemap, checkoutOutcome.cumulativeIdRemap);
    }
    const snapshot = await readMemoryLedger(absLedgerPath, params.nowMs);
    const selection = selectUnscopedRecordsAndEvaluateNotes({
      records: snapshot.records,
      role: params.role,
      repoId: params.config.repoId,
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
          opSummary: `init(${params.role}) note lifecycle update`,
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
 * Reads an existing `.memory/.session-state/<sessionId>.json` if present on disk so `memory_init`
 * can preserve `transcriptPath` and `lastScannedTranscriptOffset` (§6.2 Step 3).
 *
 * @param {string} workspaceRoot - Absolute path to the workspace root directory.
 * @param {string} sessionId     - Validated session identifier.
 *
 * @returns {MemorySessionEpochState | undefined} Existing validated session state, or `undefined`.
 */
function readExistingSessionStateIfPresent(
  workspaceRoot: string,
  sessionId: string,
): MemorySessionEpochState | undefined {
  const statePath = path.resolve(workspaceRoot, SESSION_STATE_REL_DIR, `${sessionId}.json`);
  if (!existsSync(statePath)) {
    return undefined;
  }
  try {
    const parsed = MemorySessionEpochStateSchema.safeParse(
      JSON.parse(readFileSync(statePath, 'utf8')),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Executes the `memory_init` tool contract (§6.2, §8.1): validates `role` and `sessionId`, updates
 * `latest-role.json` under `latest-role.lock`, acquires `<sessionId>.lock` first and `<ledgerPath>.lock`
 * second, loads unscoped memories, initializes `<sessionId>.json` with `PENDING_HOOK_EPOCH`, and
 * generates the config-adapted `protocol` markdown.
 *
 * @param {ExecuteMemoryInitParams} params - Workspace root, config, `MemoryInitInput`, and `nowMs`.
 *
 * @returns {Promise<MemoryInitOutput>} Validated `MemoryInitOutput` payload.
 *
 * @throws {MemoryHarnessError} With `'INVALID_ROLE'`, `'VALIDATION_FAILED'`, or `'GIT_SYNC_FAILED'`.
 */
export async function executeMemoryInit(params: ExecuteMemoryInitParams): Promise<MemoryInitOutput> {
  assertAllowedRole(params.input.role, params.config.allowedRoles);
  const sessionId = resolveToolSessionId(params.input.sessionId);
  const nowIso = new Date(params.nowMs).toISOString();
  await persistLatestRoleUnderLock(params.workspaceRoot, params.input.role, nowIso);
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
      const ledgerOutcome = await runInitLedgerSectionUnderLock({
        workspaceRoot: params.workspaceRoot,
        config: params.config,
        role: params.input.role,
        nowMs: params.nowMs,
        cumulativeIdRemap,
      });
      const existingSession = readExistingSessionStateIfPresent(params.workspaceRoot, sessionId);
      const nextSessionState: MemorySessionEpochState = Object.freeze({
        sessionId,
        role: params.input.role,
        lastCompactionCheckpointId: PENDING_HOOK_EPOCH,
        seenRecordIds: [],
        lastScannedTranscriptOffset: existingSession?.lastScannedTranscriptOffset ?? 0,
        transcriptPath: existingSession?.transcriptPath,
        updatedAt: nowIso,
      });
      await persistSessionEpochState(params.workspaceRoot, nextSessionState);
      return ledgerOutcome;
    });
  } else {
    loadedRecords = await runInitLedgerSectionUnderLock({
      workspaceRoot: params.workspaceRoot,
      config: params.config,
      role: params.input.role,
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
  const protocol = buildMemoryProtocol(params.config, params.input.role);
  return Object.freeze<MemoryInitOutput>({
    role: params.input.role,
    repoId: params.config.repoId,
    protocol,
    rules: [...loadedRecords.rules],
    lessons: [...loadedRecords.lessons],
    notes: [...loadedRecords.notes],
  });
}
