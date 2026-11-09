import path from 'node:path';
import { withFileLock } from '@paraharness/lockfile';
import { MemoryHarnessError } from '../memory-harness-error.js';
import type { MemoryConfig } from '../schemas/memory-config.schema.js';
import type {
  MemoryLessonRecord,
  MemoryNoteRecord,
  MemoryRecord,
  MemoryRuleRecord,
} from '../schemas/memory-record.schema.js';
import {
  MemoryCommitInputSchema,
  type MemoryCommitInput,
  type MemoryCommitOutput,
} from '../schemas/memory-tools.schema.js';
import { assertAllowedRole } from './assert-allowed-role.js';
import { ensureMemoryGitCheckout } from './ensure-memory-git-checkout.js';
import { deduplicateReposArray } from './hydrate-and-validate-propose-choices.js';
import { isGlobPattern } from './is-glob-pattern.js';
import { listRepoFiles } from './list-repo-files.js';
import type { MemoryLedgerSnapshot } from './memory-ledger-snapshot.js';
import { normalizeMemoryPathArray } from './normalize-memory-path-pattern.js';
import { readMemoryLedger } from './read-memory-ledger.js';
import {
  applyIdRemapToRecordIds,
  composeCumulativeIdRemap,
} from './reconcile-diverged-memory-ledgers.js';
import { remapSingleMemoryRecord } from './remap-loaded-memory-records.js';
import { remapOtherSessionStatesAfterLockRelease } from './remap-other-session-states-after-lock-release.js';
import {
  isRecordActiveForRepo,
  resolveRecordCapBucket,
} from './resolve-record-cap-bucket.js';
import { syncMemoryGit } from './sync-memory-git.js';
import { validateLessonTextFormat } from './validate-lesson-text-format.js';
import {
  allocateNextMemoryRecordId,
  writeMemoryLedger,
} from './write-memory-ledger.js';

/**
 * Parameter object for `executeMemoryCommit`.
 */
export interface ExecuteMemoryCommitParams {
  /** Absolute path to the workspace root directory. */
  readonly workspaceRoot: string;
  /** Validated unified memory configuration. */
  readonly config: MemoryConfig;
  /** Pre-compiled `forbidRegexes` patterns from `loadMemoryConfig`. */
  readonly compiledForbidRegexes: readonly RegExp[];
  /** Discriminated `'add' | 'update' | 'remove'` commit input payload. */
  readonly input: MemoryCommitInput;
  /** Current UTC timestamp in epoch milliseconds. */
  readonly nowMs: number;
}

/**
 * Parameter object for the per-op commit handlers executed under `<ledgerPath>.lock`.
 */
export interface CommitUnderLockContextParams {
  /** Absolute path to the workspace root directory. */
  readonly workspaceRoot: string;
  /** Absolute path to `memory.jsonl`. */
  readonly absLedgerPath: string;
  /** Validated unified memory configuration. */
  readonly config: MemoryConfig;
  /** Current ledger and metadata snapshot loaded under lock. */
  readonly snapshot: MemoryLedgerSnapshot;
  /** Tracked workspace-relative POSIX file paths. */
  readonly repoFiles: readonly string[];
  /** Normalized context array (`null` when explicitly widened on `update`, `undefined` when omitted). */
  readonly normalizedContext: readonly string[] | null | undefined;
  /** Deduplicated repos array (`null` when explicitly widened on `update`, `undefined` when omitted). */
  readonly normalizedRepos: readonly string[] | null | undefined;
  /** Current UTC timestamp in epoch milliseconds. */
  readonly nowMs: number;
  /** Current UTC timestamp in ISO-8601 format. */
  readonly nowIso: string;
  /** Mutable cumulative ID remap updated in-place on Git reconciliation. */
  readonly cumulativeIdRemap: Map<string, string>;
}

/**
 * Deduplicates two string arrays into a single frozen array preserving first-seen order.
 *
 * @param {readonly string[]} first  - First array of strings.
 * @param {readonly string[]} second - Second array of strings.
 *
 * @returns {readonly string[]} Frozen deduplicated union array.
 */
function unionStringArraysPreservingOrder(
  first: readonly string[],
  second: readonly string[],
): readonly string[] {
  const seen = new Set<string>();
  const combined: string[] = [];
  for (const entry of first) {
    if (!seen.has(entry)) {
      seen.add(entry);
      combined.push(entry);
    }
  }
  for (const entry of second) {
    if (!seen.has(entry)) {
      seen.add(entry);
      combined.push(entry);
    }
  }
  return Object.freeze(combined);
}

/**
 * Enforces the pre-lock role, rule-protection, schema, path normalization, and lesson format gates (§6.5 Steps 1–2).
 *
 * @param {ExecuteMemoryCommitParams} params - Commit execution parameters.
 *
 * @returns {{ readonly validatedInput: MemoryCommitInput; readonly normalizedContext: readonly string[] | null | undefined; readonly normalizedRepos: readonly string[] | null | undefined }} Validated input and normalized scope fields.
 *
 * @throws {MemoryHarnessError} With `'INVALID_ROLE'`, `'RULE_PROTECTION_VIOLATION'`, `'VALIDATION_FAILED'`, or `'LESSON_FORMAT_INVALID'`.
 */
function validatePreLockCommitInput(params: ExecuteMemoryCommitParams): {
  readonly validatedInput: MemoryCommitInput;
  readonly normalizedContext: readonly string[] | null | undefined;
  readonly normalizedRepos: readonly string[] | null | undefined;
} {
  const { input, config, compiledForbidRegexes, workspaceRoot } = params;
  assertAllowedRole(input.callerRole, config.allowedRoles, 'callerRole');
  if ((input.op === 'add' || input.op === 'update') && input.role !== undefined) {
    assertAllowedRole(input.role, config.allowedRoles, 'role');
  }
  if (
    input.op === 'add' &&
    input.type !== 'rule' &&
    input.capMerge !== undefined &&
    (input.capMerge.keepId.startsWith('R') || input.capMerge.removeId.startsWith('R'))
  ) {
    throw new MemoryHarnessError(
      'RULE_PROTECTION_VIOLATION',
      `Non-rule commit (type '${input.type}') cannot capMerge rule records ('${input.capMerge.keepId}', '${input.capMerge.removeId}').`,
      { capMerge: input.capMerge, type: input.type },
    );
  }
  if (
    input.op === 'update' &&
    !input.id.startsWith('R') &&
    input.alsoRemoveIds !== undefined &&
    input.alsoRemoveIds.some((remId) => remId.startsWith('R'))
  ) {
    throw new MemoryHarnessError(
      'RULE_PROTECTION_VIOLATION',
      `Non-rule update on '${input.id}' cannot remove rule records via alsoRemoveIds.`,
      { id: input.id, alsoRemoveIds: input.alsoRemoveIds },
    );
  }
  const parsedSchema = MemoryCommitInputSchema.safeParse(input);
  if (!parsedSchema.success) {
    throw new MemoryHarnessError(
      'VALIDATION_FAILED',
      `Invalid memory_commit input: ${parsedSchema.error.message}`,
      { issues: parsedSchema.error.issues },
    );
  }
  const validatedInput = parsedSchema.data;
  let normalizedContext: readonly string[] | null | undefined;
  let normalizedRepos: readonly string[] | null | undefined;
  if (validatedInput.op === 'add' || validatedInput.op === 'update') {
    if (validatedInput.context === null) {
      normalizedContext = null;
    } else if (validatedInput.context !== undefined) {
      normalizedContext = normalizeMemoryPathArray(validatedInput.context, workspaceRoot);
    }
    if (validatedInput.repos === null) {
      normalizedRepos = null;
    } else if (validatedInput.repos !== undefined) {
      for (const rawRepo of validatedInput.repos) {
        if (rawRepo.trim().length === 0) {
          throw new MemoryHarnessError(
            'VALIDATION_FAILED',
            'Repository identifier in repos must not be empty.',
            { repos: validatedInput.repos },
          );
        }
      }
      normalizedRepos = deduplicateReposArray(validatedInput.repos);
    }
  }
  if (validatedInput.op === 'add' && validatedInput.type === 'lesson') {
    validateLessonTextFormat(validatedInput.text, config.format, compiledForbidRegexes);
    if (validatedInput.capMerge !== undefined) {
      validateLessonTextFormat(
        validatedInput.capMerge.mergedText,
        config.format,
        compiledForbidRegexes,
      );
    }
  }
  if (validatedInput.op === 'update' && validatedInput.id.startsWith('L')) {
    validateLessonTextFormat(validatedInput.text, config.format, compiledForbidRegexes);
  }
  return Object.freeze({
    validatedInput,
    normalizedContext,
    normalizedRepos,
  });
}

/**
 * Constructs a typed `MemoryRecord` for `op: 'add'`.
 *
 * @param {{ readonly id: string; readonly input: Extract<MemoryCommitInput, { readonly op: 'add' }>; readonly normalizedContext: readonly string[] | undefined; readonly normalizedRepos: readonly string[] | undefined; readonly nowIso: string }} params - Record construction fields.
 *
 * @returns {MemoryRecord} Newly constructed frozen `MemoryRecord`.
 */
function buildAddedMemoryRecord(params: {
  readonly id: string;
  readonly input: Extract<MemoryCommitInput, { readonly op: 'add' }>;
  readonly normalizedContext: readonly string[] | undefined;
  readonly normalizedRepos: readonly string[] | undefined;
  readonly nowIso: string;
}): MemoryRecord {
  const baseFields = {
    id: params.id,
    role: params.input.role,
    text: params.input.text.trim(),
    createdAt: params.nowIso,
    updatedAt: undefined,
    context:
      params.normalizedContext !== undefined ? [...params.normalizedContext] : undefined,
    repos: params.normalizedRepos !== undefined ? [...params.normalizedRepos] : undefined,
  };
  if (params.input.type === 'rule') {
    return Object.freeze<MemoryRuleRecord>({
      ...baseFields,
      type: 'rule',
    });
  }
  if (params.input.type === 'lesson') {
    return Object.freeze<MemoryLessonRecord>({
      ...baseFields,
      type: 'lesson',
    });
  }
  if (params.input.lifecycle === undefined) {
    throw new MemoryHarnessError(
      'VALIDATION_FAILED',
      'lifecycle is required when adding a note record.',
    );
  }
  return Object.freeze<MemoryNoteRecord>({
    ...baseFields,
    type: 'note',
    lifecycle: params.input.lifecycle,
  });
}

/**
 * Applies `input.capMerge` inside `<ledgerPath>.lock` for `op: 'add'`, validating bucket zone,
 * record existence, bucket membership, and same-type/same-role constraints (§6.5 Step 3).
 *
 * @param {CommitUnderLockContextParams}                        ctx          - Active commit lock context.
 * @param {Extract<MemoryCommitInput, { readonly op: 'add' }>}  input        - Validated `op: 'add'` input.
 * @param {ReturnType<typeof resolveRecordCapBucket>}           bucketStatus - Pre-add target bucket status.
 *
 * @returns {{ readonly workingRecords: readonly MemoryRecord[]; readonly mergedKeepRecord: MemoryRecord | null; readonly removedIds: readonly string[] }} Updated working records, merged keep record, and removed ID list.
 *
 * @throws {MemoryHarnessError} With `'VALIDATION_FAILED'` or `'RECORD_NOT_FOUND'`.
 */
function applyCapMergeOnAdd(
  ctx: CommitUnderLockContextParams,
  input: Extract<MemoryCommitInput, { readonly op: 'add' }>,
  bucketStatus: ReturnType<typeof resolveRecordCapBucket>,
): {
  readonly workingRecords: readonly MemoryRecord[];
  readonly mergedKeepRecord: MemoryRecord | null;
  readonly removedIds: readonly string[];
} {
  if (input.capMerge === undefined) {
    return {
      workingRecords: ctx.snapshot.records,
      mergedKeepRecord: null,
      removedIds: [],
    };
  }
  if (bucketStatus.zone !== 'SOFT_CAP_PRESSURE' && bucketStatus.zone !== 'AT_HARD_CAP') {
    throw new MemoryHarnessError(
      'VALIDATION_FAILED',
      `capMerge is only permitted in SOFT_CAP_PRESSURE or AT_HARD_CAP zones (current zone: '${bucketStatus.zone}').`,
      { zone: bucketStatus.zone, bucketStatus },
    );
  }
  const { keepId, removeId, mergedText } = input.capMerge;
  let keepRecord: MemoryRecord | undefined;
  let removeRecord: MemoryRecord | undefined;
  for (const record of ctx.snapshot.records) {
    if (!isRecordActiveForRepo(record, ctx.config.repoId)) {
      continue;
    }
    if (record.id === keepId) keepRecord = record;
    if (record.id === removeId) removeRecord = record;
  }
  if (keepRecord === undefined || removeRecord === undefined) {
    throw new MemoryHarnessError(
      'RECORD_NOT_FOUND',
      `capMerge target record '${keepRecord === undefined ? keepId : removeId}' not found in active records for repo '${ctx.config.repoId}'.`,
      { keepId, removeId },
    );
  }
  const bucketIdSet = new Set<string>(bucketStatus.bucketRecordIds);
  if (
    !bucketIdSet.has(keepId) ||
    !bucketIdSet.has(removeId) ||
    keepRecord.type !== input.type ||
    removeRecord.type !== input.type ||
    keepRecord.role !== removeRecord.role
  ) {
    throw new MemoryHarnessError(
      'VALIDATION_FAILED',
      `capMerge records '${keepId}' and '${removeId}' must belong to target bucket '${bucketStatus.bucketId}', match type '${input.type}', and share the same role.`,
      { keepId, removeId, bucketId: bucketStatus.bucketId },
    );
  }
  const unionedContext =
    keepRecord.context !== undefined && removeRecord.context !== undefined
      ? [...unionStringArraysPreservingOrder(keepRecord.context, removeRecord.context)]
      : undefined;
  const unionedRepos =
    keepRecord.repos !== undefined && removeRecord.repos !== undefined
      ? [...unionStringArraysPreservingOrder(keepRecord.repos, removeRecord.repos)]
      : undefined;
  const mergedKeepRecord: MemoryRecord = Object.freeze({
    ...keepRecord,
    text: mergedText.trim(),
    updatedAt: ctx.nowIso,
    context: unionedContext,
    repos: unionedRepos,
  });
  const workingRecords: MemoryRecord[] = [];
  for (const record of ctx.snapshot.records) {
    if (record.id === removeId) {
      continue;
    }
    if (record.id === keepId) {
      workingRecords.push(mergedKeepRecord);
      continue;
    }
    workingRecords.push(record);
  }
  return {
    workingRecords,
    mergedKeepRecord,
    removedIds: [removeId],
  };
}

/**
 * Executes `op === 'add'` inside `<ledgerPath>.lock` (§6.5 Step 3).
 *
 * @param {CommitUnderLockContextParams}                       ctx   - Active commit lock context.
 * @param {Extract<MemoryCommitInput, { readonly op: 'add' }>} input - Validated `op: 'add'` input.
 *
 * @returns {Promise<MemoryCommitOutput>} Commit output payload for `op: 'add'`.
 */
async function executeCommitAddUnderLock(
  ctx: CommitUnderLockContextParams,
  input: Extract<MemoryCommitInput, { readonly op: 'add' }>,
): Promise<MemoryCommitOutput> {
  const candidateContext = ctx.normalizedContext ?? undefined;
  const candidateRepos = ctx.normalizedRepos ?? undefined;
  const bucketStatus = resolveRecordCapBucket({
    candidate: {
      type: input.type,
      role: input.role,
      context: candidateContext,
      repos: candidateRepos,
    },
    records: ctx.snapshot.records,
    config: ctx.config,
    repoFiles: ctx.repoFiles,
  });
  const capMergeOutcome = applyCapMergeOnAdd(ctx, input, bucketStatus);
  const prefix: 'R' | 'L' | 'N' =
    input.type === 'rule' ? 'R' : input.type === 'lesson' ? 'L' : 'N';
  const allocated = allocateNextMemoryRecordId(
    ctx.snapshot.meta,
    ctx.snapshot.records,
    prefix,
  );
  const addedRecord = buildAddedMemoryRecord({
    id: allocated.id,
    input,
    normalizedContext: candidateContext,
    normalizedRepos: candidateRepos,
    nowIso: ctx.nowIso,
  });
  const nextRecords: MemoryRecord[] = [...capMergeOutcome.workingRecords, addedRecord];
  if (isRecordActiveForRepo(addedRecord, ctx.config.repoId)) {
    const postAddBucket = resolveRecordCapBucket({
      candidate: addedRecord,
      records: nextRecords,
      config: ctx.config,
      repoFiles: ctx.repoFiles,
    });
    const hardCapExceeded =
      postAddBucket.hardCap !== null && postAddBucket.currentCount > postAddBucket.hardCap;
    const totalExceeded =
      ctx.config.maxTotalRecords !== undefined &&
      postAddBucket.totalRecordsCount > ctx.config.maxTotalRecords;
    if (hardCapExceeded || totalExceeded) {
      throw new MemoryHarnessError(
        'CAP_EXCEEDED',
        `Cannot add record to bucket '${postAddBucket.bucketId}': capacity exceeded (${postAddBucket.currentCount}/${postAddBucket.hardCap ?? 'unlimited'}, total ${postAddBucket.totalRecordsCount}/${postAddBucket.maxTotalRecords ?? 'unlimited'}).`,
        { bucketStatus: postAddBucket },
      );
    }
  }
  await writeMemoryLedger({
    ledgerPath: ctx.absLedgerPath,
    records: nextRecords,
    meta: allocated.meta,
    writeMeta: true,
    writeLedger: true,
  });
  const syncOutcome = await syncMemoryGit({
    workspaceRoot: ctx.workspaceRoot,
    config: ctx.config,
    opSummary: `add ${addedRecord.id}`,
    preOpSnapshot: { records: ctx.snapshot.records, meta: ctx.snapshot.meta },
    capCheckCandidate: addedRecord,
    repoFiles: ctx.repoFiles,
    nowMs: ctx.nowMs,
  });
  composeCumulativeIdRemap(ctx.cumulativeIdRemap, syncOutcome.cumulativeIdRemap);
  const finalCommittedRecord = remapSingleMemoryRecord(
    addedRecord,
    syncOutcome.cumulativeIdRemap,
  );
  const finalMergedKeepRecord =
    capMergeOutcome.mergedKeepRecord !== null
      ? remapSingleMemoryRecord(capMergeOutcome.mergedKeepRecord, syncOutcome.cumulativeIdRemap)
      : null;
  const finalRemovedIds = applyIdRemapToRecordIds(
    capMergeOutcome.removedIds,
    syncOutcome.cumulativeIdRemap,
  );
  const bucketStatusAfter = isRecordActiveForRepo(finalCommittedRecord, ctx.config.repoId)
    ? resolveRecordCapBucket({
        candidate: finalCommittedRecord,
        records: syncOutcome.records,
        config: ctx.config,
        repoFiles: ctx.repoFiles,
      })
    : null;
  return Object.freeze<MemoryCommitOutput>({
    op: 'add',
    committedRecord: finalCommittedRecord,
    previousRecord: null,
    mergedKeepRecord: finalMergedKeepRecord,
    removedIds: [...finalRemovedIds],
    bucketStatusAfter,
    gitCommitted: syncOutcome.gitCommitted,
    gitPushed: syncOutcome.gitPushed,
  });
}

/**
 * Executes `op === 'update'` inside `<ledgerPath>.lock` (§6.5 Step 3).
 *
 * @param {CommitUnderLockContextParams}                          ctx   - Active commit lock context.
 * @param {Extract<MemoryCommitInput, { readonly op: 'update' }>} input - Validated `op: 'update'` input.
 *
 * @returns {Promise<MemoryCommitOutput>} Commit output payload for `op: 'update'`.
 */
async function executeCommitUpdateUnderLock(
  ctx: CommitUnderLockContextParams,
  input: Extract<MemoryCommitInput, { readonly op: 'update' }>,
): Promise<MemoryCommitOutput> {
  const recordById = new Map<string, MemoryRecord>();
  for (const record of ctx.snapshot.records) {
    recordById.set(record.id, record);
  }
  const target = recordById.get(input.id);
  if (target === undefined) {
    throw new MemoryHarnessError(
      'RECORD_NOT_FOUND',
      `Record '${input.id}' not found in ledger.`,
      { id: input.id },
    );
  }
  if (input.lifecycle !== undefined && target.type !== 'note') {
    throw new MemoryHarnessError(
      'VALIDATION_FAILED',
      `lifecycle cannot be updated on non-note record '${input.id}'.`,
      { id: input.id, type: target.type },
    );
  }
  const removeIdSet = new Set<string>();
  if (input.alsoRemoveIds !== undefined) {
    for (const remId of input.alsoRemoveIds) {
      if (target.type !== 'rule' && remId.startsWith('R')) {
        throw new MemoryHarnessError(
          'RULE_PROTECTION_VIOLATION',
          `Non-rule update on '${input.id}' cannot remove rule record '${remId}'.`,
          { id: input.id, alsoRemoveId: remId },
        );
      }
      const remRecord = recordById.get(remId);
      if (remRecord === undefined) {
        throw new MemoryHarnessError(
          'RECORD_NOT_FOUND',
          `alsoRemoveIds record '${remId}' not found in ledger.`,
          { alsoRemoveId: remId },
        );
      }
      if (
        remId === input.id ||
        removeIdSet.has(remId) ||
        remRecord.type !== target.type ||
        !isRecordActiveForRepo(remRecord, ctx.config.repoId)
      ) {
        throw new MemoryHarnessError(
          'VALIDATION_FAILED',
          `alsoRemoveIds entry '${remId}' must be unique, distinct from '${input.id}', match type '${target.type}', and apply to repo '${ctx.config.repoId}'.`,
          { id: input.id, alsoRemoveId: remId },
        );
      }
      removeIdSet.add(remId);
    }
  }
  const recordsWithoutRemoved: MemoryRecord[] = [];
  for (const record of ctx.snapshot.records) {
    if (!removeIdSet.has(record.id)) {
      recordsWithoutRemoved.push(record);
    }
  }
  const nextContext =
    ctx.normalizedContext === null
      ? undefined
      : ctx.normalizedContext !== undefined
        ? [...ctx.normalizedContext]
        : target.context;
  const nextRepos =
    ctx.normalizedRepos === null
      ? undefined
      : ctx.normalizedRepos !== undefined
        ? [...ctx.normalizedRepos]
        : target.repos;
  const updatedRecord: MemoryRecord =
    target.type === 'note'
      ? Object.freeze<MemoryNoteRecord>({
          ...target,
          text: input.text.trim(),
          role: input.role ?? target.role,
          context: nextContext,
          repos: nextRepos,
          lifecycle: input.lifecycle ?? target.lifecycle,
          updatedAt: ctx.nowIso,
        })
      : Object.freeze({
          ...target,
          text: input.text.trim(),
          role: input.role ?? target.role,
          context: nextContext,
          repos: nextRepos,
          updatedAt: ctx.nowIso,
        });
  const workingRecords: MemoryRecord[] = [];
  for (const record of recordsWithoutRemoved) {
    workingRecords.push(record.id === target.id ? updatedRecord : record);
  }
  const wasActiveForRepo = isRecordActiveForRepo(target, ctx.config.repoId);
  const isNowActiveForRepo = isRecordActiveForRepo(updatedRecord, ctx.config.repoId);
  const oldBucketId = wasActiveForRepo
    ? resolveRecordCapBucket({
        candidate: target,
        records: recordsWithoutRemoved,
        config: ctx.config,
        repoFiles: ctx.repoFiles,
      }).bucketId
    : null;
  const newBucketStatus = isNowActiveForRepo
    ? resolveRecordCapBucket({
        candidate: updatedRecord,
        records: workingRecords,
        config: ctx.config,
        repoFiles: ctx.repoFiles,
      })
    : null;
  const transitionedIntoNewActiveBucket =
    isNowActiveForRepo && (!wasActiveForRepo || oldBucketId !== newBucketStatus?.bucketId);
  if (transitionedIntoNewActiveBucket && newBucketStatus !== null) {
    const hardCapExceeded =
      newBucketStatus.hardCap !== null && newBucketStatus.currentCount > newBucketStatus.hardCap;
    const totalExceeded =
      ctx.config.maxTotalRecords !== undefined &&
      newBucketStatus.totalRecordsCount > ctx.config.maxTotalRecords;
    if (hardCapExceeded || totalExceeded) {
      throw new MemoryHarnessError(
        'CAP_EXCEEDED',
        `Updating '${input.id}' transitions into bucket '${newBucketStatus.bucketId}' which exceeds capacity.`,
        { id: input.id, bucketStatus: newBucketStatus },
      );
    }
  }
  await writeMemoryLedger({
    ledgerPath: ctx.absLedgerPath,
    records: workingRecords,
    meta: ctx.snapshot.meta,
    writeMeta: ctx.snapshot.metaNeedsWrite,
    writeLedger: true,
  });
  const syncOutcome = await syncMemoryGit({
    workspaceRoot: ctx.workspaceRoot,
    config: ctx.config,
    opSummary: `update ${updatedRecord.id}`,
    preOpSnapshot: { records: ctx.snapshot.records, meta: ctx.snapshot.meta },
    capCheckCandidate: transitionedIntoNewActiveBucket ? updatedRecord : undefined,
    repoFiles: ctx.repoFiles,
    nowMs: ctx.nowMs,
  });
  composeCumulativeIdRemap(ctx.cumulativeIdRemap, syncOutcome.cumulativeIdRemap);
  const finalCommittedRecord = remapSingleMemoryRecord(
    updatedRecord,
    syncOutcome.cumulativeIdRemap,
  );
  const finalRemovedIds = applyIdRemapToRecordIds(
    input.alsoRemoveIds ?? [],
    syncOutcome.cumulativeIdRemap,
  );
  const bucketStatusAfter = isRecordActiveForRepo(finalCommittedRecord, ctx.config.repoId)
    ? resolveRecordCapBucket({
        candidate: finalCommittedRecord,
        records: syncOutcome.records,
        config: ctx.config,
        repoFiles: ctx.repoFiles,
      })
    : null;
  return Object.freeze<MemoryCommitOutput>({
    op: 'update',
    committedRecord: finalCommittedRecord,
    previousRecord: target,
    mergedKeepRecord: null,
    removedIds: [...finalRemovedIds],
    bucketStatusAfter,
    gitCommitted: syncOutcome.gitCommitted,
    gitPushed: syncOutcome.gitPushed,
  });
}

/**
 * Executes `op === 'remove'` inside `<ledgerPath>.lock` (§6.5 Step 3).
 *
 * @param {CommitUnderLockContextParams}                          ctx   - Active commit lock context.
 * @param {Extract<MemoryCommitInput, { readonly op: 'remove' }>} input - Validated `op: 'remove'` input.
 *
 * @returns {Promise<MemoryCommitOutput>} Commit output payload for `op: 'remove'`.
 */
async function executeCommitRemoveUnderLock(
  ctx: CommitUnderLockContextParams,
  input: Extract<MemoryCommitInput, { readonly op: 'remove' }>,
): Promise<MemoryCommitOutput> {
  let target: MemoryRecord | undefined;
  const remainingRecords: MemoryRecord[] = [];
  for (const record of ctx.snapshot.records) {
    if (record.id === input.id) {
      target = record;
      continue;
    }
    remainingRecords.push(record);
  }
  if (target === undefined) {
    throw new MemoryHarnessError(
      'RECORD_NOT_FOUND',
      `Record '${input.id}' not found in ledger.`,
      { id: input.id },
    );
  }
  if (target.type === 'rule' && input.reason !== 'owner_veto') {
    throw new MemoryHarnessError(
      'RULE_PROTECTION_VIOLATION',
      `Rule record '${input.id}' can only be removed with reason 'owner_veto' (got '${input.reason}').`,
      { id: input.id, reason: input.reason },
    );
  }
  if (
    (input.reason === 'note_settled_or_obsolete' && target.type !== 'note') ||
    (target.type === 'note' &&
      (input.reason === 'promoted_to_tier1_or_tier2' ||
        input.reason === 'merged_into_wider_record'))
  ) {
    throw new MemoryHarnessError(
      'VALIDATION_FAILED',
      `Removal reason '${input.reason}' is invalid for record '${input.id}' of type '${target.type}'.`,
      { id: input.id, type: target.type, reason: input.reason },
    );
  }
  await writeMemoryLedger({
    ledgerPath: ctx.absLedgerPath,
    records: remainingRecords,
    meta: ctx.snapshot.meta,
    writeMeta: ctx.snapshot.metaNeedsWrite,
    writeLedger: true,
  });
  const syncOutcome = await syncMemoryGit({
    workspaceRoot: ctx.workspaceRoot,
    config: ctx.config,
    opSummary: `remove ${target.id}`,
    nowMs: ctx.nowMs,
  });
  composeCumulativeIdRemap(ctx.cumulativeIdRemap, syncOutcome.cumulativeIdRemap);
  const bucketStatusAfter = isRecordActiveForRepo(target, ctx.config.repoId)
    ? resolveRecordCapBucket({
        candidate: target,
        records: syncOutcome.records,
        config: ctx.config,
        repoFiles: ctx.repoFiles,
      })
    : null;
  return Object.freeze<MemoryCommitOutput>({
    op: 'remove',
    committedRecord: null,
    previousRecord: target,
    mergedKeepRecord: null,
    removedIds: [target.id],
    bucketStatusAfter,
    gitCommitted: syncOutcome.gitCommitted,
    gitPushed: syncOutcome.gitPushed,
  });
}

/**
 * Checks whether `config.caps` contains any capacity rule with an explicit glob pattern (`p !== '*' && isGlobPattern(p)`),
 * which is the only condition under which `resolveRecordCapBucket` inspects `repoFiles` (§5.2.1).
 *
 * @param {MemoryConfig} config - Validated unified memory configuration.
 *
 * @returns {boolean} `true` if at least one capacity rule path is an explicit glob pattern; `false` otherwise.
 */
function hasExplicitGlobCapPaths(config: MemoryConfig): boolean {
  return config.caps.some((cap) => cap.paths.some((p) => p !== '*' && isGlobPattern(p)));
}

/**
 * Executes the `memory_commit` tool contract (§6.5, §8.1, §8.2): enforces pre-lock role,
 * rule-protection, schema, and lesson format gates, acquires `<ledgerPath>.lock`, executes `add`,
 * `update`, or `remove` with monotonic ID allocation and capacity enforcement, runs Git
 * auto-commit/push with 3-way reconciliation, and remaps any affected session state files after
 * lock release.
 *
 * @param {ExecuteMemoryCommitParams} params - Workspace root, config, compiled regexes, `MemoryCommitInput`, and `nowMs`.
 *
 * @returns {Promise<MemoryCommitOutput>} Validated `MemoryCommitOutput` payload.
 *
 * @throws {MemoryHarnessError} With `'INVALID_ROLE'`, `'VALIDATION_FAILED'`, `'LESSON_FORMAT_INVALID'`, `'CAP_EXCEEDED'`, `'RECORD_NOT_FOUND'`, `'RULE_PROTECTION_VIOLATION'`, or `'GIT_SYNC_FAILED'`.
 */
export async function executeMemoryCommit(
  params: ExecuteMemoryCommitParams,
): Promise<MemoryCommitOutput> {
  const { validatedInput, normalizedContext, normalizedRepos } = validatePreLockCommitInput(params);
  const repoFiles = hasExplicitGlobCapPaths(params.config)
    ? await listRepoFiles(params.workspaceRoot)
    : [];
  const absLedgerPath = path.resolve(params.workspaceRoot, params.config.storage.ledgerPath);
  const ledgerLockPath = `${absLedgerPath}.lock`;
  const nowIso = new Date(params.nowMs).toISOString();
  const cumulativeIdRemap = new Map<string, string>();
  const commitOutcome = await withFileLock(ledgerLockPath, async () => {
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
    const lockCtx: CommitUnderLockContextParams = {
      workspaceRoot: params.workspaceRoot,
      absLedgerPath,
      config: params.config,
      snapshot,
      repoFiles,
      normalizedContext,
      normalizedRepos,
      nowMs: params.nowMs,
      nowIso,
      cumulativeIdRemap,
    };
    if (validatedInput.op === 'add') {
      return executeCommitAddUnderLock(lockCtx, validatedInput);
    }
    if (validatedInput.op === 'update') {
      return executeCommitUpdateUnderLock(lockCtx, validatedInput);
    }
    return executeCommitRemoveUnderLock(lockCtx, validatedInput);
  });
  if (cumulativeIdRemap.size > 0) {
    await remapOtherSessionStatesAfterLockRelease(params.workspaceRoot, cumulativeIdRemap);
  }
  return commitOutcome;
}
