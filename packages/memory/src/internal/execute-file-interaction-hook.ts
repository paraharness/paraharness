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
  FileInteractionHookInputSchema,
  type FileInteractionHookInput,
  type FileInteractionHookOutput,
  type MemoryLoadedNoteRecord,
  type MemorySessionEpochState,
} from '../schemas/memory-tools.schema.js';
import { assertAllowedRole } from './assert-allowed-role.js';
import { ensureMemoryGitCheckout } from './ensure-memory-git-checkout.js';
import { evaluateNoteLifecycleOnRead } from './evaluate-note-lifecycle-on-read.js';
import { listRepoFiles } from './list-repo-files.js';
import { matchesContextScope } from './matches-context-scope.js';
import { SESSION_STATE_REL_DIR } from './memory-protocol.constants.js';
import { normalizeMemoryPathPattern } from './normalize-memory-path-pattern.js';
import { readMemoryLedger } from './read-memory-ledger.js';
import {
  applyIdRemapToRecordIds,
  composeCumulativeIdRemap,
} from './reconcile-diverged-memory-ledgers.js';
import { remapLoadedMemoryRecords } from './remap-loaded-memory-records.js';
import { remapOtherSessionStatesAfterLockRelease } from './remap-other-session-states-after-lock-release.js';
import { isRecordActiveForRepo } from './resolve-record-cap-bucket.js';
import {
  persistSessionEpochState,
  resolveSessionEpochState,
} from './resolve-session-epoch-state.js';
import { syncMemoryGit } from './sync-memory-git.js';
import { writeMemoryLedger } from './write-memory-ledger.js';

/**
 * Parameter object for `executeFileInteractionHook`.
 */
export interface ExecuteFileInteractionHookParams {
  /** Absolute path to the workspace root directory. */
  readonly workspaceRoot: string;
  /** Validated unified memory configuration. */
  readonly config: MemoryConfig;
  /** Hook input payload (`sessionId`, `touchedPaths`, and optional `role` and `transcriptPath`). */
  readonly input: FileInteractionHookInput;
  /** Current UTC timestamp in epoch milliseconds. */
  readonly nowMs: number;
}

/**
 * Parameter object for `selectUnseenScopedRecordsForHook`.
 */
export interface SelectUnseenScopedRecordsParams {
  /** Canonically sorted active records from `readMemoryLedger`. */
  readonly records: readonly MemoryRecord[];
  /** Resolved active session role name. */
  readonly resolvedRole: string;
  /** Active repository identifier from `config.repoId`. */
  readonly repoId: string;
  /** Normalized in-workspace touched paths/globs. */
  readonly touchedPaths: readonly string[];
  /** Tracked workspace-relative POSIX file paths. */
  readonly repoFiles: readonly string[];
  /** Set of record IDs already seen in the current compaction epoch. */
  readonly seenRecordIdSet: ReadonlySet<string>;
  /** Current UTC timestamp in epoch milliseconds. */
  readonly nowMs: number;
}

/**
 * Parameter object for `runHookLedgerSectionUnderLock`.
 */
export interface RunHookLedgerSectionParams {
  /** Absolute path to the workspace root directory. */
  readonly workspaceRoot: string;
  /** Validated unified memory configuration. */
  readonly config: MemoryConfig;
  /** Resolved active role name. */
  readonly resolvedRole: string;
  /** Normalized in-workspace touched paths/globs. */
  readonly touchedPaths: readonly string[];
  /** Tracked workspace-relative POSIX file paths. */
  readonly repoFiles: readonly string[];
  /** Current `seenRecordIds` from `<sessionId>.json`. */
  readonly initialSeenRecordIds: readonly string[];
  /** Current UTC timestamp in epoch milliseconds. */
  readonly nowMs: number;
  /** Mutable cumulative ID remap updated in-place on Git reconciliation. */
  readonly cumulativeIdRemap: Map<string, string>;
}

/**
 * Parameter object for `formatHookInjectedContext`.
 */
export interface FormatHookInjectedContextParams {
  /** Resolved active role name. */
  readonly role: string;
  /** Active compaction checkpoint identifier. */
  readonly compactionEpochId: string;
  /** Normalized in-workspace touched paths/globs. */
  readonly touchedPaths: readonly string[];
  /** Newly injected scoped rule records. */
  readonly rules: readonly MemoryRuleRecord[];
  /** Newly injected scoped lesson records. */
  readonly lessons: readonly MemoryLessonRecord[];
  /** Newly injected scoped note records. */
  readonly notes: readonly MemoryLoadedNoteRecord[];
}

/**
 * Normalizes and deduplicates raw `touchedPaths` alongside `transcriptTouchedPaths`, skipping
 * out-of-workspace entries that throw `MemoryHarnessError('VALIDATION_FAILED')` (§7.2 Step 3).
 *
 * @param {readonly string[]} rawTouchedPaths        - Direct `input.touchedPaths` entries.
 * @param {readonly string[]} transcriptTouchedPaths - Tool-step paths extracted from `transcript.jsonl`.
 * @param {string}            workspaceRoot          - Absolute path to the workspace root directory.
 *
 * @returns {readonly string[]} Frozen array of valid normalized in-workspace POSIX paths/globs.
 */
function collectValidInWorkspaceTouchedPaths(
  rawTouchedPaths: readonly string[],
  transcriptTouchedPaths: readonly string[],
  workspaceRoot: string,
): readonly string[] {
  const seen = new Set<string>();
  const validPaths: string[] = [];
  const combined = [...rawTouchedPaths, ...transcriptTouchedPaths];
  for (const rawPath of combined) {
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
      continue;
    }
    try {
      const normalized = normalizeMemoryPathPattern(rawPath, workspaceRoot);
      if (!seen.has(normalized)) {
        seen.add(normalized);
        validPaths.push(normalized);
      }
    } catch (err) {
      if (err instanceof MemoryHarnessError && err.code === 'VALIDATION_FAILED') {
        continue;
      }
      throw err;
    }
  }
  return Object.freeze(validPaths);
}

/**
 * Selects unseen scoped records matching `touchedPaths`, `resolvedRole`, and `repoId`, applying
 * §3.3 lifecycle transitions **only** to newly matched unseen notes (§3.3 Invariant 2, §7.2 Step 4).
 *
 * @param {SelectUnseenScopedRecordsParams} params - Active records, role, repoId, touchedPaths, `repoFiles`, `seenRecordIdSet`, and `nowMs`.
 *
 * @returns {{ readonly rules: readonly MemoryRuleRecord[]; readonly lessons: readonly MemoryLessonRecord[]; readonly notes: readonly MemoryLoadedNoteRecord[]; readonly retainedRecords: readonly MemoryRecord[]; readonly notesMutated: boolean }} Newly injected records, retained ledger records, and mutation flag.
 */
function selectUnseenScopedRecordsForHook(params: SelectUnseenScopedRecordsParams): {
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
    const isUnseenScopedMatch =
      !params.seenRecordIdSet.has(record.id) &&
      record.context !== undefined &&
      record.context.length > 0 &&
      (record.role === 'general' || record.role === params.resolvedRole) &&
      isRecordActiveForRepo(record, params.repoId) &&
      matchesContextScope(params.touchedPaths, record.context, params.repoFiles);
    if (!isUnseenScopedMatch) {
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
 * Executes the `<ledgerPath>.lock` critical section (acquired **second** inside `<sessionId>.lock`
 * per §8.1 Rule 1) for `handleFileInteractionHook` (§7.2 Step 4).
 *
 * @param {RunHookLedgerSectionParams} params - Workspace root, config, role, touched paths, `repoFiles`, seen IDs, and clock.
 *
 * @returns {Promise<{ readonly rules: readonly MemoryRuleRecord[]; readonly lessons: readonly MemoryLessonRecord[]; readonly notes: readonly MemoryLoadedNoteRecord[] }>} Newly injected rules, lessons, and notes.
 */
function runHookLedgerSectionUnderLock(params: RunHookLedgerSectionParams): Promise<{
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
    const remappedInitialSeen = applyIdRemapToRecordIds(
      params.initialSeenRecordIds,
      params.cumulativeIdRemap,
    );
    const seenSet = new Set<string>(remappedInitialSeen);
    const snapshot = await readMemoryLedger(absLedgerPath, params.nowMs);
    const selection = selectUnseenScopedRecordsForHook({
      records: snapshot.records,
      resolvedRole: params.resolvedRole,
      repoId: params.config.repoId,
      touchedPaths: params.touchedPaths,
      repoFiles: params.repoFiles,
      seenRecordIdSet: seenSet,
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
          opSummary: `hook(${params.resolvedRole}) note lifecycle update`,
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
 * Formats newly injected scoped rules, lessons, and notes into a structured markdown block in
 * §1.2 canonical presentation order (`R*` -> `L*` -> `N*`).
 *
 * @param {FormatHookInjectedContextParams} params - Role, compaction epoch ID, touched paths, and injected records.
 *
 * @returns {string} Non-empty formatted markdown context string.
 */
function formatHookInjectedContext(params: FormatHookInjectedContextParams): string {
  const lines: string[] = [
    `# Scoped Unified Memory (role: \`${params.role}\`, epoch: \`${params.compactionEpochId}\`, paths: ${params.touchedPaths.map((p) => `\`${p}\``).join(', ')})`,
  ];
  if (params.rules.length > 0) {
    lines.push('', '## Scoped Rules (`R*`)');
    for (const rule of params.rules) {
      const ctxLabel = rule.context !== undefined ? ` [${rule.context.join(', ')}]` : '';
      lines.push(`- **${rule.id}** (${rule.role}${ctxLabel}): ${rule.text}`);
    }
  }
  if (params.lessons.length > 0) {
    lines.push('', '## Scoped Lessons (`L*`)');
    for (const lesson of params.lessons) {
      const ctxLabel = lesson.context !== undefined ? ` [${lesson.context.join(', ')}]` : '';
      lines.push(`- **${lesson.id}** (${lesson.role}${ctxLabel}): ${lesson.text}`);
    }
  }
  if (params.notes.length > 0) {
    lines.push('', '## Scoped Operational Notes (`N*`)');
    for (const note of params.notes) {
      const ctxLabel = note.context !== undefined ? ` [${note.context.join(', ')}]` : '';
      lines.push(`- **${note.id}** (${note.role}${ctxLabel}): ${note.renderedText}`);
    }
  }
  return lines.join('\n');
}

/**
 * Executes the Just-In-Time File-Interaction Hook contract (§7.1–§7.2, §8.1): validates `sessionId`
 * and optional `role`, acquires `.memory/.session-state/<sessionId>.lock` **first**, resolves the
 * compaction epoch and role fallback chain (`resolveSessionEpochState`), normalizes `touchedPaths`
 * (exiting early without acquiring `<ledgerPath>.lock` if only out-of-workspace paths were touched),
 * acquires `<ledgerPath>.lock` **second**, matches unseen scoped records, applies note lifecycles,
 * persists in §8.1 Rule 2 order, and returns the formatted injection payload.
 *
 * @param {ExecuteFileInteractionHookParams} params - Workspace root, config, `FileInteractionHookInput`, and `nowMs`.
 *
 * @returns {Promise<FileInteractionHookOutput>} Validated `FileInteractionHookOutput` payload.
 *
 * @throws {MemoryHarnessError} With `'INVALID_ROLE'`, `'VALIDATION_FAILED'`, or `'GIT_SYNC_FAILED'`.
 */
export async function executeFileInteractionHook(
  params: ExecuteFileInteractionHookParams,
): Promise<FileInteractionHookOutput> {
  if (params.input.role !== undefined) {
    assertAllowedRole(params.input.role, params.config.allowedRoles, 'role');
  }
  const parsedInput = FileInteractionHookInputSchema.safeParse(params.input);
  if (!parsedInput.success) {
    throw new MemoryHarnessError(
      'VALIDATION_FAILED',
      `Invalid handleFileInteractionHook input: ${parsedInput.error.message}`,
      { issues: parsedInput.error.issues },
    );
  }
  const validatedInput = parsedInput.data;
  const sessionStateDir = path.resolve(params.workspaceRoot, SESSION_STATE_REL_DIR);
  await mkdir(sessionStateDir, { recursive: true });
  const sessionLockPath = path.join(sessionStateDir, `${validatedInput.sessionId}.lock`);
  const cumulativeIdRemap = new Map<string, string>();
  const hookOutcome = await withFileLock(sessionLockPath, async () => {
    const epochResolution = await resolveSessionEpochState({
      workspaceRoot: params.workspaceRoot,
      config: params.config,
      sessionId: validatedInput.sessionId,
      role: validatedInput.role,
      transcriptPath: validatedInput.transcriptPath,
      persistState: false,
      nowMs: params.nowMs,
    });
    const validTouchedPaths = collectValidInWorkspaceTouchedPaths(
      validatedInput.touchedPaths,
      epochResolution.transcriptTouchedPaths,
      params.workspaceRoot,
    );
    if (validTouchedPaths.length === 0) {
      await persistSessionEpochState(params.workspaceRoot, epochResolution.state);
      return Object.freeze<FileInteractionHookOutput>({
        injected: false,
        compactionEpochId: epochResolution.compactionEpochId,
        formattedContext: null,
        rules: [],
        lessons: [],
        notes: [],
      });
    }
    const repoFiles = await listRepoFiles(params.workspaceRoot);
    const ledgerOutcome = await runHookLedgerSectionUnderLock({
      workspaceRoot: params.workspaceRoot,
      config: params.config,
      resolvedRole: epochResolution.resolvedRole,
      touchedPaths: validTouchedPaths,
      repoFiles,
      initialSeenRecordIds: epochResolution.state.seenRecordIds,
      nowMs: params.nowMs,
      cumulativeIdRemap,
    });
    const remappedPriorSeen = applyIdRemapToRecordIds(
      epochResolution.state.seenRecordIds,
      cumulativeIdRemap,
    );
    const seenSet = new Set<string>(remappedPriorSeen);
    const mergedSeenIds: string[] = [...remappedPriorSeen];
    const newlyInjectedIds: string[] = [];
    for (const rule of ledgerOutcome.rules) newlyInjectedIds.push(rule.id);
    for (const lesson of ledgerOutcome.lessons) newlyInjectedIds.push(lesson.id);
    for (const note of ledgerOutcome.notes) newlyInjectedIds.push(note.id);
    for (const id of newlyInjectedIds) {
      if (!seenSet.has(id)) {
        seenSet.add(id);
        mergedSeenIds.push(id);
      }
    }
    const updatedSessionState: MemorySessionEpochState = Object.freeze({
      ...epochResolution.state,
      seenRecordIds: mergedSeenIds,
    });
    await persistSessionEpochState(params.workspaceRoot, updatedSessionState);
    if (newlyInjectedIds.length === 0) {
      return Object.freeze<FileInteractionHookOutput>({
        injected: false,
        compactionEpochId: epochResolution.compactionEpochId,
        formattedContext: null,
        rules: [],
        lessons: [],
        notes: [],
      });
    }
    const formattedContext = formatHookInjectedContext({
      role: epochResolution.resolvedRole,
      compactionEpochId: epochResolution.compactionEpochId,
      touchedPaths: validTouchedPaths,
      rules: ledgerOutcome.rules,
      lessons: ledgerOutcome.lessons,
      notes: ledgerOutcome.notes,
    });
    return Object.freeze<FileInteractionHookOutput>({
      injected: true,
      compactionEpochId: epochResolution.compactionEpochId,
      formattedContext,
      rules: [...ledgerOutcome.rules],
      lessons: [...ledgerOutcome.lessons],
      notes: [...ledgerOutcome.notes],
    });
  });
  if (cumulativeIdRemap.size > 0) {
    await remapOtherSessionStatesAfterLockRelease(
      params.workspaceRoot,
      cumulativeIdRemap,
      validatedInput.sessionId,
    );
  }
  return hookOutcome;
}
