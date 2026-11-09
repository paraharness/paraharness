import { MemoryHarnessError } from '../memory-harness-error.js';
import type { MemoryConfig } from '../schemas/memory-config.schema.js';
import type {
  MemoryLessonRecord,
  MemoryRecord,
  MemoryRuleRecord,
} from '../schemas/memory-record.schema.js';
import type {
  DistillerChoiceOutput,
  DistillerStructuredOutput,
  MemoryBucketStatus,
  MemoryProposalChoice,
  MemoryProposeInput,
} from '../schemas/memory-tools.schema.js';
import { normalizeMemoryPathArray } from './normalize-memory-path-pattern.js';
import {
  isRecordActiveForRepo,
  resolveRecordCapBucket,
  type CapCandidateRecord,
} from './resolve-record-cap-bucket.js';
import { validateLessonTextFormat } from './validate-lesson-text-format.js';

/**
 * Parameter object for `hydrateAndValidateProposeChoices`.
 */
export interface HydrateAndValidateProposeChoicesParams {
  /** Absolute path to the workspace root directory. */
  readonly workspaceRoot: string;
  /** Validated unified memory configuration. */
  readonly config: MemoryConfig;
  /** Pre-compiled `forbidRegexes` patterns from `loadMemoryConfig`. */
  readonly compiledForbidRegexes: readonly RegExp[];
  /** Candidate proposal input (`type`, `targetRole`, `context`, `repos`). */
  readonly candidate: MemoryProposeInput;
  /** Normalized candidate context array (when `candidate.context` was provided). */
  readonly normalizedContext?: readonly string[];
  /** Deduplicated candidate repos array (when `candidate.repos` was provided). */
  readonly normalizedRepos?: readonly string[];
  /** Active ledger records snapshot. */
  readonly records: readonly MemoryRecord[];
  /** Tracked workspace-relative POSIX file paths. */
  readonly repoFiles: readonly string[];
  /** Evaluated target capacity bucket status for the candidate. */
  readonly bucketStatus: MemoryBucketStatus;
  /** Structured output returned by the Distiller runner. */
  readonly distillerOutput: DistillerStructuredOutput;
}

/**
 * Parameter object for `validateAndHydrateSingleChoice`.
 */
export interface ValidateAndHydrateSingleChoiceParams {
  /** Shared proposal validation context. */
  readonly context: HydrateAndValidateProposeChoicesParams;
  /** Raw choice item from `distillerOutput.choices`. */
  readonly choice: DistillerChoiceOutput;
  /** Active rules and lessons indexed by ID for `config.repoId`. */
  readonly activeRecordById: ReadonlyMap<string, MemoryRuleRecord | MemoryLessonRecord>;
  /** Set of record IDs currently belonging to `bucketStatus.bucketRecordIds`. */
  readonly bucketRecordIdSet: ReadonlySet<string>;
}

/**
 * Checks whether two optional string arrays have identical length and element order.
 *
 * @param {readonly string[] | undefined} left  - First optional string array.
 * @param {readonly string[] | undefined} right - Second optional string array.
 *
 * @returns {boolean} `true` if both are `undefined` or both contain the exact same strings in order.
 */
function areOptionalStringArraysEqual(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === undefined && right === undefined) {
    return true;
  }
  if (left === undefined || right === undefined || left.length !== right.length) {
    return false;
  }
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Deduplicates an optional array of repository identifiers while preserving first-seen order.
 *
 * @param {readonly string[] | undefined} rawRepos - Raw repository identifier list.
 *
 * @returns {readonly string[] | undefined} Deduplicated repository list, or `undefined`.
 */
export function deduplicateReposArray(
  rawRepos: readonly string[] | undefined,
): readonly string[] | undefined {
  if (rawRepos === undefined) {
    return undefined;
  }
  const seen = new Set<string>();
  const deduplicated: string[] = [];
  for (const repo of rawRepos) {
    const trimmed = repo.trim();
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      deduplicated.push(trimmed);
    }
  }
  return Object.freeze(deduplicated);
}

/**
 * Enforces rule protection and type-prefix consistency across all IDs referenced by `choice` (§6.4 Step 4).
 *
 * @param {DistillerChoiceOutput} choice        - Choice item produced by the Distiller.
 * @param {'rule' | 'lesson'}     candidateType - Candidate proposal type (`input.type`).
 *
 * @returns {void}
 *
 * @throws {MemoryHarnessError} With `'RULE_PROTECTION_VIOLATION'` if a lesson references `R*`, or `'DISTILLER_EXECUTION_FAILED'` on prefix mismatch.
 */
function assertChoiceRuleProtectionAndTypePrefix(
  choice: DistillerChoiceOutput,
  candidateType: 'rule' | 'lesson',
): void {
  const referencedIds: string[] = [];
  if (choice.op === 'update') {
    referencedIds.push(choice.targetId);
    if (choice.alsoRemoveIds !== undefined) {
      for (const remId of choice.alsoRemoveIds) {
        referencedIds.push(remId);
      }
    }
  } else if (choice.capMerge !== undefined) {
    referencedIds.push(choice.capMerge.keepId, choice.capMerge.removeId);
  }
  const expectedPrefix = candidateType === 'rule' ? 'R' : 'L';
  for (const refId of referencedIds) {
    if (candidateType === 'lesson' && refId.startsWith('R')) {
      throw new MemoryHarnessError(
        'RULE_PROTECTION_VIOLATION',
        `Lesson proposal choice cannot reference or modify rule record '${refId}'.`,
        { referencedId: refId, candidateType },
      );
    }
    if (!refId.startsWith(expectedPrefix)) {
      throw new MemoryHarnessError(
        'DISTILLER_EXECUTION_FAILED',
        `Distiller choice referenced ID '${refId}' which does not match expected prefix '${expectedPrefix}'.`,
        { referencedId: refId, expectedPrefix },
      );
    }
  }
}

/**
 * Normalizes `choice.proposedContext` (when an array is provided), wrapping normalization errors
 * into `MemoryHarnessError('DISTILLER_EXECUTION_FAILED')` per §6.4 Step 4.
 *
 * @param {readonly string[] | null | undefined} proposedContext - Raw `proposedContext` on the choice.
 * @param {string}                               workspaceRoot   - Absolute path to the workspace root directory.
 *
 * @returns {readonly string[] | null | undefined} Normalized context array, `null`, or `undefined`.
 *
 * @throws {MemoryHarnessError} With `'DISTILLER_EXECUTION_FAILED'` if any context pattern is invalid.
 */
function normalizeChoiceProposedContext(
  proposedContext: readonly string[] | null | undefined,
  workspaceRoot: string,
): readonly string[] | null | undefined {
  if (proposedContext === undefined || proposedContext === null) {
    return proposedContext;
  }
  try {
    return normalizeMemoryPathArray(proposedContext, workspaceRoot);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new MemoryHarnessError(
      'DISTILLER_EXECUTION_FAILED',
      `Distiller choice contains invalid proposedContext: ${message}`,
      { proposedContext },
    );
  }
}

/**
 * Validates an `op: 'add'` choice from the Distiller, checking scope preservation, `capMerge`
 * zone/bucket/role/type invariants, and lesson text formatting (§6.4 Step 4).
 *
 * @param {ValidateAndHydrateSingleChoiceParams} params          - Choice and validation context.
 * @param {readonly string[] | undefined}        normalizedCtx   - Normalized `proposedContext` array.
 * @param {readonly string[] | undefined}        dedupedRepos    - Deduplicated `proposedRepos` array.
 *
 * @returns {MemoryProposalChoice} Validated `op: 'add'` proposal choice.
 *
 * @throws {MemoryHarnessError} With `'DISTILLER_EXECUTION_FAILED'` or `'LESSON_FORMAT_INVALID'`.
 */
function validateAddChoice(
  params: ValidateAndHydrateSingleChoiceParams,
  normalizedCtx: readonly string[] | undefined,
  dedupedRepos: readonly string[] | undefined,
): MemoryProposalChoice {
  const { choice, context, activeRecordById, bucketRecordIdSet } = params;
  if (choice.op !== 'add') {
    throw new MemoryHarnessError('DISTILLER_EXECUTION_FAILED', 'Expected op: "add" choice.');
  }
  if (
    choice.proposedRole !== context.candidate.targetRole ||
    !areOptionalStringArraysEqual(normalizedCtx, context.normalizedContext) ||
    !areOptionalStringArraysEqual(dedupedRepos, context.normalizedRepos)
  ) {
    throw new MemoryHarnessError(
      'DISTILLER_EXECUTION_FAILED',
      'Distiller op: "add" choice must preserve candidate targetRole, normalizedContext, and repos.',
      {
        proposedRole: choice.proposedRole,
        expectedRole: context.candidate.targetRole,
        proposedContext: normalizedCtx,
        expectedContext: context.normalizedContext,
        proposedRepos: dedupedRepos,
        expectedRepos: context.normalizedRepos,
      },
    );
  }
  if (choice.capMerge !== undefined) {
    const zone = context.bucketStatus.zone;
    if (zone !== 'SOFT_CAP_PRESSURE' && zone !== 'AT_HARD_CAP') {
      throw new MemoryHarnessError(
        'DISTILLER_EXECUTION_FAILED',
        `Distiller proposed capMerge in zone '${zone}', where capMerge is forbidden.`,
        { zone, capMerge: choice.capMerge },
      );
    }
    const { keepId, removeId } = choice.capMerge;
    if (
      keepId === removeId ||
      !bucketRecordIdSet.has(keepId) ||
      !bucketRecordIdSet.has(removeId)
    ) {
      throw new MemoryHarnessError(
        'DISTILLER_EXECUTION_FAILED',
        `Distiller capMerge IDs '${keepId}' and '${removeId}' must be distinct members of bucket '${context.bucketStatus.bucketId}'.`,
        { keepId, removeId, bucketRecordIds: context.bucketStatus.bucketRecordIds },
      );
    }
    const keepRecord = activeRecordById.get(keepId);
    const removeRecord = activeRecordById.get(removeId);
    if (
      keepRecord === undefined ||
      removeRecord === undefined ||
      keepRecord.type !== context.candidate.type ||
      removeRecord.type !== context.candidate.type ||
      keepRecord.role !== removeRecord.role
    ) {
      throw new MemoryHarnessError(
        'DISTILLER_EXECUTION_FAILED',
        `Distiller capMerge records '${keepId}' and '${removeId}' must exist and share the same type and role.`,
        { keepId, removeId },
      );
    }
  }
  const trimmedProposedText =
    context.candidate.type === 'lesson'
      ? validateLessonTextFormat(
          choice.proposedText,
          context.config.format,
          context.compiledForbidRegexes,
        )
      : choice.proposedText.trim();
  const validatedCapMerge =
    choice.capMerge !== undefined
      ? Object.freeze({
          keepId: choice.capMerge.keepId,
          removeId: choice.capMerge.removeId,
          mergedText:
            context.candidate.type === 'lesson'
              ? validateLessonTextFormat(
                  choice.capMerge.mergedText,
                  context.config.format,
                  context.compiledForbidRegexes,
                )
              : choice.capMerge.mergedText.trim(),
          whyMerged: choice.capMerge.whyMerged.trim(),
        })
      : undefined;
  return Object.freeze<MemoryProposalChoice>({
    op: 'add',
    proposedText: trimmedProposedText,
    proposedRole: choice.proposedRole,
    proposedContext: normalizedCtx !== undefined ? [...normalizedCtx] : undefined,
    proposedRepos: dedupedRepos !== undefined ? [...dedupedRepos] : undefined,
    capMerge: validatedCapMerge,
  });
}

/**
 * Validates and hydrates an `op: 'update'` choice from the Distiller, checking target and
 * `alsoRemoveIds` existence, destination bucket capacity on transition, and lesson text formatting (§6.4 Step 4).
 *
 * @param {ValidateAndHydrateSingleChoiceParams} params          - Choice and validation context.
 * @param {readonly string[] | null | undefined} normalizedCtx   - Normalized `proposedContext`.
 * @param {readonly string[] | null | undefined} dedupedRepos    - Deduplicated `proposedRepos`.
 *
 * @returns {MemoryProposalChoice} Hydrated `op: 'update'` proposal choice.
 *
 * @throws {MemoryHarnessError} With `'DISTILLER_EXECUTION_FAILED'` or `'LESSON_FORMAT_INVALID'`.
 */
function validateAndHydrateUpdateChoice(
  params: ValidateAndHydrateSingleChoiceParams,
  normalizedCtx: readonly string[] | null | undefined,
  dedupedRepos: readonly string[] | null | undefined,
): MemoryProposalChoice {
  const { choice, context, activeRecordById } = params;
  if (choice.op !== 'update') {
    throw new MemoryHarnessError('DISTILLER_EXECUTION_FAILED', 'Expected op: "update" choice.');
  }
  const targetRecord = activeRecordById.get(choice.targetId);
  if (targetRecord === undefined || targetRecord.type !== context.candidate.type) {
    throw new MemoryHarnessError(
      'DISTILLER_EXECUTION_FAILED',
      `Distiller update targetId '${choice.targetId}' does not exist in active '${context.candidate.type}' records for repo '${context.config.repoId}'.`,
      { targetId: choice.targetId },
    );
  }
  const removeIdSet = new Set<string>();
  if (choice.alsoRemoveIds !== undefined) {
    for (const remId of choice.alsoRemoveIds) {
      if (remId === choice.targetId || removeIdSet.has(remId)) {
        throw new MemoryHarnessError(
          'DISTILLER_EXECUTION_FAILED',
          `Distiller update alsoRemoveIds contains duplicate or target ID '${remId}'.`,
          { targetId: choice.targetId, alsoRemoveIds: choice.alsoRemoveIds },
        );
      }
      const remRecord = activeRecordById.get(remId);
      if (remRecord === undefined || remRecord.type !== context.candidate.type) {
        throw new MemoryHarnessError(
          'DISTILLER_EXECUTION_FAILED',
          `Distiller update alsoRemoveIds entry '${remId}' does not exist in active '${context.candidate.type}' records.`,
          { alsoRemoveIds: choice.alsoRemoveIds },
        );
      }
      removeIdSet.add(remId);
    }
  }
  const remainingRecords: MemoryRecord[] = [];
  for (const rec of context.records) {
    if (!removeIdSet.has(rec.id)) {
      remainingRecords.push(rec);
    }
  }
  const updatedContext =
    normalizedCtx === null
      ? undefined
      : normalizedCtx !== undefined
        ? [...normalizedCtx]
        : targetRecord.context;
  const updatedRepos =
    dedupedRepos === null
      ? undefined
      : dedupedRepos !== undefined
        ? [...dedupedRepos]
        : targetRecord.repos;
  const simulatedCandidate: CapCandidateRecord = {
    type: targetRecord.type,
    role: choice.proposedRole,
    context: updatedContext,
    repos: updatedRepos,
  };
  if (isRecordActiveForRepo(simulatedCandidate, context.config.repoId)) {
    const oldBucket = resolveRecordCapBucket({
      candidate: targetRecord,
      records: remainingRecords,
      config: context.config,
      repoFiles: context.repoFiles,
    });
    const simulatedRecords: MemoryRecord[] = [];
    for (const rec of remainingRecords) {
      if (rec.id === targetRecord.id) {
        simulatedRecords.push(
          Object.freeze({
            ...targetRecord,
            role: choice.proposedRole,
            context: updatedContext,
            repos: updatedRepos,
          }),
        );
      } else {
        simulatedRecords.push(rec);
      }
    }
    const newBucket = resolveRecordCapBucket({
      candidate: simulatedCandidate,
      records: simulatedRecords,
      config: context.config,
      repoFiles: context.repoFiles,
    });
    if (oldBucket.bucketId !== newBucket.bucketId) {
      const hardCapExceeded =
        newBucket.hardCap !== null && newBucket.currentCount > newBucket.hardCap;
      const totalExceeded =
        context.config.maxTotalRecords !== undefined &&
        newBucket.totalRecordsCount > context.config.maxTotalRecords;
      if (hardCapExceeded || totalExceeded) {
        throw new MemoryHarnessError(
          'DISTILLER_EXECUTION_FAILED',
          `Distiller update choice on '${choice.targetId}' transitions to bucket '${newBucket.bucketId}' which exceeds capacity.`,
          { targetId: choice.targetId, newBucket },
        );
      }
    }
  }
  const trimmedProposedText =
    context.candidate.type === 'lesson'
      ? validateLessonTextFormat(
          choice.proposedText,
          context.config.format,
          context.compiledForbidRegexes,
        )
      : choice.proposedText.trim();
  return Object.freeze<MemoryProposalChoice>({
    op: 'update',
    targetId: choice.targetId,
    existingRecord: targetRecord,
    whyMatched: choice.whyMatched.trim(),
    proposedText: trimmedProposedText,
    proposedRole: choice.proposedRole,
    proposedContext:
      normalizedCtx === null
        ? null
        : normalizedCtx !== undefined
          ? [...normalizedCtx]
          : undefined,
    proposedRepos:
      dedupedRepos === null
        ? null
        : dedupedRepos !== undefined
          ? [...dedupedRepos]
          : undefined,
    alsoRemoveIds: choice.alsoRemoveIds !== undefined ? [...choice.alsoRemoveIds] : undefined,
  });
}

/**
 * Validates and hydrates a single `DistillerChoiceOutput` item against the active ledger snapshot
 * and configuration constraints (§6.4 Step 4).
 *
 * @param {ValidateAndHydrateSingleChoiceParams} params - Choice, validation context, and pre-indexed sets.
 *
 * @returns {MemoryProposalChoice} Validated and hydrated `MemoryProposalChoice`.
 *
 * @throws {MemoryHarnessError} With `'RULE_PROTECTION_VIOLATION'`, `'LESSON_FORMAT_INVALID'`, or `'DISTILLER_EXECUTION_FAILED'`.
 */
function validateAndHydrateSingleChoice(
  params: ValidateAndHydrateSingleChoiceParams,
): MemoryProposalChoice {
  const { choice, context } = params;
  assertChoiceRuleProtectionAndTypePrefix(choice, context.candidate.type);
  if (!context.config.allowedRoles.includes(choice.proposedRole)) {
    throw new MemoryHarnessError(
      'DISTILLER_EXECUTION_FAILED',
      `Distiller choice proposed disallowed role '${choice.proposedRole}'.`,
      { proposedRole: choice.proposedRole, allowedRoles: context.config.allowedRoles },
    );
  }
  const normalizedCtx = normalizeChoiceProposedContext(
    choice.proposedContext,
    context.workspaceRoot,
  );
  const dedupedRepos =
    choice.proposedRepos === null ? null : deduplicateReposArray(choice.proposedRepos);
  if (choice.op === 'add') {
    return validateAddChoice(
      params,
      normalizedCtx ?? undefined,
      dedupedRepos ?? undefined,
    );
  }
  return validateAndHydrateUpdateChoice(params, normalizedCtx, dedupedRepos);
}

/**
 * Validates top-level `DistillerStructuredOutput` invariants and hydrates every choice in
 * `distillerOutput.choices` with `existingRecord` from the in-memory ledger snapshot (§6.4 Step 4).
 *
 * @param {HydrateAndValidateProposeChoicesParams} params - Workspace root, config, candidate, ledger snapshot, bucket status, and Distiller output.
 *
 * @returns {readonly MemoryProposalChoice[]} Frozen array of validated, hydrated proposal choices.
 *
 * @throws {MemoryHarnessError} With `'RULE_PROTECTION_VIOLATION'`, `'LESSON_FORMAT_INVALID'`, or `'DISTILLER_EXECUTION_FAILED'`.
 */
export function hydrateAndValidateProposeChoices(
  params: HydrateAndValidateProposeChoicesParams,
): readonly MemoryProposalChoice[] {
  const { distillerOutput, candidate, bucketStatus, records, config } = params;
  if (distillerOutput.matchStatus === 'REJECTED_TIER_1_OR_2' && candidate.type === 'rule') {
    throw new MemoryHarnessError(
      'DISTILLER_EXECUTION_FAILED',
      'Distiller cannot return REJECTED_TIER_1_OR_2 for an Owner-mandated rule proposal.',
      { matchStatus: distillerOutput.matchStatus, type: candidate.type },
    );
  }
  if (
    distillerOutput.matchStatus === 'NO_MATCH' &&
    distillerOutput.choices.length === 0 &&
    bucketStatus.zone !== 'AT_HARD_CAP'
  ) {
    throw new MemoryHarnessError(
      'DISTILLER_EXECUTION_FAILED',
      `Distiller returned NO_MATCH with empty choices in zone '${bucketStatus.zone}'.`,
      { matchStatus: distillerOutput.matchStatus, zone: bucketStatus.zone },
    );
  }
  const activeRecordById = new Map<string, MemoryRuleRecord | MemoryLessonRecord>();
  for (const record of records) {
    if (
      (record.type === 'rule' || record.type === 'lesson') &&
      isRecordActiveForRepo(record, config.repoId)
    ) {
      activeRecordById.set(record.id, record);
    }
  }
  const bucketRecordIdSet = new Set<string>(bucketStatus.bucketRecordIds);
  const hydratedChoices: MemoryProposalChoice[] = [];
  for (const choice of distillerOutput.choices) {
    hydratedChoices.push(
      validateAndHydrateSingleChoice({
        context: params,
        choice,
        activeRecordById,
        bucketRecordIdSet,
      }),
    );
  }
  return Object.freeze(hydratedChoices);
}
