import type { MemoryCapRule, MemoryConfig } from '../schemas/memory-config.schema.js';
import type { MemoryRecord, MemoryRecordType } from '../schemas/memory-record.schema.js';
import type { MemoryBucketStatus } from '../schemas/memory-tools.schema.js';
import { buildRelativeProbes } from './build-relative-probes.js';
import { extractStaticDirPrefix } from './extract-static-dir-prefix.js';
import { getCompiledPicomatch } from './get-compiled-picomatch.js';
import { isDirectoryCandidate } from './is-directory-candidate.js';
import { isGlobPattern } from './is-glob-pattern.js';
import {
  CONSECUTIVE_SLASHES_REGEX,
  LEADING_DOT_SLASH_REGEX,
  PROBE_FILE_SEGMENT,
  PROBE_SUBDIR_SEGMENT,
  TRAILING_SLASHES_REGEX,
} from './memory-protocol.constants.js';
import { sortMemoryRecordsCanonically } from './sort-memory-records-canonically.js';

/**
 * Candidate or persisted record shape evaluated against `config.caps` capacity rules.
 */
export interface CapCandidateRecord {
  /** Record category (`'rule' | 'lesson' | 'note'`). */
  readonly type: MemoryRecordType;
  /** Target role name (`'general'` or a specific role). */
  readonly role: string;
  /** Optional normalized workspace-relative context paths or globs. */
  readonly context?: readonly string[];
  /** Optional repository scope list. */
  readonly repos?: readonly string[];
}

/**
 * Parameter object for `resolveRecordCapBucket`.
 */
export interface ResolveRecordCapBucketParams {
  /** Candidate or existing record whose target capacity bucket is being resolved. */
  readonly candidate: CapCandidateRecord;
  /** All active (non-expired) records currently in `memory.jsonl`. */
  readonly records: readonly MemoryRecord[];
  /** Validated unified memory configuration. */
  readonly config: MemoryConfig;
  /** Tracked workspace-relative POSIX file paths (`defaults to []`). */
  readonly repoFiles?: readonly string[];
}

/**
 * Parameter object for `computeCapRuleSpecificityTuple`.
 */
export interface ComputeCapRuleSpecificityTupleParams {
  /** Eligible capacity rule from `config.caps`. */
  readonly capRule: MemoryCapRule;
  /** 0-based index of `capRule` in `config.caps`. */
  readonly ruleIndex: number;
  /** Record or candidate being ranked. */
  readonly record: CapCandidateRecord;
  /** Tracked workspace-relative POSIX file paths. */
  readonly repoFiles: readonly string[];
}

/**
 * Normalizes a cap rule's `paths` array into canonical POSIX patterns while preserving `'*'`.
 *
 * @param {readonly string[]} rawPaths - Raw `capRule.paths` entries from `config.caps`.
 *
 * @returns {readonly string[]} Deduplicated normalized cap rule path patterns.
 */
function normalizeCapRulePaths(rawPaths: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const rawPath of rawPaths) {
    const trimmed = rawPath.trim();
    const clean =
      trimmed === '*'
        ? '*'
        : trimmed
            .replaceAll('\\', '/')
            .replace(CONSECUTIVE_SLASHES_REGEX, '/')
            .replace(LEADING_DOT_SLASH_REGEX, '')
            .replace(TRAILING_SLASHES_REGEX, '');
    if (clean.length > 0 && !seen.has(clean)) {
      seen.add(clean);
      normalized.push(clean);
    }
  }
  return normalized;
}

/**
 * Checks whether a record applies to the current repository (`record.repos === undefined || record.repos.includes(repoId)`) per §5.1.
 *
 * @param {{ readonly repos?: readonly string[] }} record - Record or candidate to inspect.
 * @param {string}                                 repoId - Active repository identifier from `config.repoId`.
 *
 * @returns {boolean} `true` if `record` applies to `repoId`; `false` otherwise.
 */
export function isRecordActiveForRepo(
  record: { readonly repos?: readonly string[] },
  repoId: string,
): boolean {
  return record.repos === undefined || record.repos.includes(repoId);
}

/**
 * Determines whether a single normalized cap rule pattern `p` covers a single normalized record
 * context pattern `c` against `repoFiles` per §5.2.1.
 *
 * @param {string}            p           - Normalized cap rule path or glob pattern (excluding `'*'`).
 * @param {string}            c           - Normalized record context path or glob pattern.
 * @param {readonly string[]} [repoFiles] - Tracked workspace-relative POSIX file paths.
 *
 * @returns {boolean} `true` if `p` covers `c` under §5.2.1.
 */
export function isContextCoveredByCapPattern(
  p: string,
  c: string,
  repoFiles: readonly string[] = [],
): boolean {
  const pIsGlob = isGlobPattern(p);
  const cIsGlob = isGlobPattern(c);
  const pDirPrefix = pIsGlob ? extractStaticDirPrefix(p) : p;
  const cDirPrefix = cIsGlob ? extractStaticDirPrefix(c) : c;
  const prefixCovered =
    pDirPrefix === '' || cDirPrefix === pDirPrefix || cDirPrefix.startsWith(`${pDirPrefix}/`);
  if (!prefixCovered) {
    return false;
  }
  if (!pIsGlob) {
    return true;
  }
  const pMatcher = getCompiledPicomatch(p);
  if (!cIsGlob) {
    if (!isDirectoryCandidate(c, repoFiles)) {
      return pMatcher(c);
    }
    return (
      pMatcher(c) ||
      (pMatcher(`${c}/${PROBE_FILE_SEGMENT}`) &&
        pMatcher(`${c}/${PROBE_SUBDIR_SEGMENT}/${PROBE_FILE_SEGMENT}`))
    );
  }
  if (p === c) {
    return true;
  }
  const cMatcher = getCompiledPicomatch(c);
  const base = cDirPrefix === '' ? '' : `${cDirPrefix}/`;
  let matchedAtLeastOneProbe = false;
  for (const relProbe of buildRelativeProbes(c)) {
    const candidatePath = `${base}${relProbe}`;
    if (cMatcher(candidatePath)) {
      matchedAtLeastOneProbe = true;
      if (!pMatcher(candidatePath)) {
        return false;
      }
    }
  }
  return matchedAtLeastOneProbe;
}

/**
 * Evaluates whether `capRule` is eligible to govern `record` across type, role, and path scope per §5.2.1.
 *
 * @param {MemoryCapRule}      capRule     - Capacity rule from `config.caps`.
 * @param {CapCandidateRecord} record      - Record or candidate being evaluated.
 * @param {readonly string[]}  [repoFiles] - Tracked workspace-relative POSIX file paths.
 *
 * @returns {boolean} `true` if `capRule` is eligible for `record`.
 */
export function isCapRuleEligibleForRecord(
  capRule: MemoryCapRule,
  record: CapCandidateRecord,
  repoFiles: readonly string[] = [],
): boolean {
  if (!capRule.types.includes(record.type)) {
    return false;
  }
  if (!capRule.roles.includes(record.role) && !capRule.roles.includes('*')) {
    return false;
  }
  const hasContext = record.context !== undefined && record.context.length > 0;
  if (!hasContext) {
    return capRule.paths.length === 0;
  }
  if (capRule.paths.includes('*')) {
    return true;
  }
  const normalizedCapPaths = normalizeCapRulePaths(capRule.paths);
  if (normalizedCapPaths.length === 0) {
    return false;
  }
  for (const contextPattern of record.context) {
    let covered = false;
    for (const capPattern of normalizedCapPaths) {
      if (isContextCoveredByCapPattern(capPattern, contextPattern, repoFiles)) {
        covered = true;
        break;
      }
    }
    if (!covered) {
      return false;
    }
  }
  return true;
}

/**
 * Computes the 6-tuple specificity ranking `(pathTier, maxPrefixSegments, maxPrefixChars, roleSpec, typeSpec, -ruleIndex)`
 * for an eligible `capRule` at `ruleIndex` against `record` per §5.2.2.
 *
 * @param {ComputeCapRuleSpecificityTupleParams} params - Eligible capacity rule, rule index, candidate record, and `repoFiles`.
 *
 * @returns {readonly [number, number, number, number, number, number]} 6-tuple specificity score.
 */
function computeCapRuleSpecificityTuple(
  params: ComputeCapRuleSpecificityTupleParams,
): readonly [number, number, number, number, number, number] {
  const roleSpec = params.capRule.roles.includes(params.record.role) ? 2 : 1;
  const typeSpec = params.capRule.types.length === 1 ? 2 : 1;
  const hasContext = params.record.context !== undefined && params.record.context.length > 0;
  if (!hasContext) {
    return [2, 0, 0, roleSpec, typeSpec, -params.ruleIndex];
  }
  if (params.capRule.paths.includes('*')) {
    return [1, 0, 0, roleSpec, typeSpec, -params.ruleIndex];
  }
  const normalizedCapPaths = normalizeCapRulePaths(params.capRule.paths);
  let minBestSegments = Number.POSITIVE_INFINITY;
  let minBestChars = Number.POSITIVE_INFINITY;
  for (const contextPattern of params.record.context) {
    let bestSegmentsForC = -1;
    let bestCharsForC = -1;
    for (const capPattern of normalizedCapPaths) {
      if (!isContextCoveredByCapPattern(capPattern, contextPattern, params.repoFiles)) {
        continue;
      }
      const pDirPrefix = isGlobPattern(capPattern)
        ? extractStaticDirPrefix(capPattern)
        : capPattern;
      const segCount = pDirPrefix === '' ? 0 : pDirPrefix.split('/').length;
      const charCount = pDirPrefix.length;
      if (
        segCount > bestSegmentsForC ||
        (segCount === bestSegmentsForC && charCount > bestCharsForC)
      ) {
        bestSegmentsForC = segCount;
        bestCharsForC = charCount;
      }
    }
    if (
      bestSegmentsForC < minBestSegments ||
      (bestSegmentsForC === minBestSegments && bestCharsForC < minBestChars)
    ) {
      minBestSegments = bestSegmentsForC;
      minBestChars = bestCharsForC;
    }
  }
  const resolvedSegs = Number.isFinite(minBestSegments) ? minBestSegments : 0;
  const resolvedChars = Number.isFinite(minBestChars) ? minBestChars : 0;
  return [2, resolvedSegs, resolvedChars, roleSpec, typeSpec, -params.ruleIndex];
}

/**
 * Compares two 6-tuple specificity scores lexicographically.
 *
 * @param {readonly [number, number, number, number, number, number]} left  - First specificity tuple.
 * @param {readonly [number, number, number, number, number, number]} right - Second specificity tuple.
 *
 * @returns {number} Positive if `left` outranks `right`, negative if `right` outranks `left`, or `0`.
 */
function compareSpecificityTuples(
  left: readonly [number, number, number, number, number, number],
  right: readonly [number, number, number, number, number, number],
): number {
  for (let idx = 0; idx < 6; idx += 1) {
    const lVal = left[idx] ?? 0;
    const rVal = right[idx] ?? 0;
    if (lVal !== rVal) {
      return lVal - rVal;
    }
  }
  return 0;
}

/**
 * Resolves the winning `config.caps` rule index and deterministic partition `bucketId` for `record` (§5.2.2–§5.2.3).
 *
 * @param {CapCandidateRecord}     record    - Record or candidate to partition.
 * @param {readonly MemoryCapRule[]} caps      - Capacity rules from `config.caps`.
 * @param {readonly string[]}      repoFiles - Tracked workspace-relative POSIX file paths.
 *
 * @returns {{ readonly winningRuleIndex: number | null; readonly bucketId: string }} Winning rule index (or `null` when uncapped) and partition `bucketId`.
 */
function resolveWinningRuleAndBucketId(
  record: CapCandidateRecord,
  caps: readonly MemoryCapRule[],
  repoFiles: readonly string[],
): { readonly winningRuleIndex: number | null; readonly bucketId: string } {
  let winningIdx: number | null = null;
  let winningTuple: readonly [number, number, number, number, number, number] | null = null;
  for (let i = 0; i < caps.length; i += 1) {
    const rule = caps[i];
    if (rule === undefined || !isCapRuleEligibleForRecord(rule, record, repoFiles)) {
      continue;
    }
    const tuple = computeCapRuleSpecificityTuple({
      capRule: rule,
      ruleIndex: i,
      record,
      repoFiles,
    });
    if (winningTuple === null || compareSpecificityTuples(tuple, winningTuple) > 0) {
      winningIdx = i;
      winningTuple = tuple;
    }
  }
  const hasContext = record.context !== undefined && record.context.length > 0;
  if (winningIdx === null) {
    const pathPartition = !hasContext
      ? 'unscoped'
      : `record-context:${[...record.context].sort().join('|')}`;
    return {
      winningRuleIndex: null,
      bucketId: `uncapped|type=${record.type}|role=role:${record.role}|path=${pathPartition}`,
    };
  }
  const winningRule = caps[winningIdx];
  const rolePartition =
    winningRule !== undefined && winningRule.roles.includes(record.role)
      ? [...winningRule.roles].sort().join(',')
      : `role:${record.role}`;
  let pathPartition: string;
  if (!hasContext) {
    pathPartition = 'unscoped';
  } else if (winningRule !== undefined && !winningRule.paths.includes('*')) {
    const normalizedCapPaths = normalizeCapRulePaths(winningRule.paths);
    pathPartition = `rule-paths:${[...normalizedCapPaths].sort().join('|')}`;
  } else {
    pathPartition = `record-context:${[...record.context].sort().join('|')}`;
  }
  return {
    winningRuleIndex: winningIdx,
    bucketId: `rule#${winningIdx}|role=${rolePartition}|path=${pathPartition}`,
  };
}

/**
 * Resolves the target capacity bucket, active bucket population `B`, and 3-zone capacity status
 * (`UNCAPPED`, `UNDER_SOFT_CAP`, `SOFT_CAP_PRESSURE`, `AT_HARD_CAP`) for a candidate or existing
 * record per §5.1–§5.3.
 *
 * @param {ResolveRecordCapBucketParams} params - Candidate record, active ledger records, config, and `repoFiles`.
 *
 * @returns {MemoryBucketStatus} Validated capacity bucket status for `params.candidate`.
 */
export function resolveRecordCapBucket(params: ResolveRecordCapBucketParams): MemoryBucketStatus {
  const repoFiles = params.repoFiles ?? [];
  const activeForRepo: MemoryRecord[] = [];
  for (const record of params.records) {
    if (isRecordActiveForRepo(record, params.config.repoId)) {
      activeForRepo.push(record);
    }
  }
  const sortedActive = sortMemoryRecordsCanonically(activeForRepo);
  const totalRecordsCount = sortedActive.length;
  const maxTotalRecords = params.config.maxTotalRecords ?? null;
  const maxTotalRecordsReached = maxTotalRecords !== null && totalRecordsCount >= maxTotalRecords;
  const target = resolveWinningRuleAndBucketId(params.candidate, params.config.caps, repoFiles);
  const bucketRecordIds: string[] = [];
  for (const record of sortedActive) {
    const member = resolveWinningRuleAndBucketId(record, params.config.caps, repoFiles);
    if (member.bucketId === target.bucketId) {
      bucketRecordIds.push(record.id);
    }
  }
  const currentCount = bucketRecordIds.length;
  const winningRule =
    target.winningRuleIndex !== null ? params.config.caps[target.winningRuleIndex] : undefined;
  if (winningRule === undefined) {
    return Object.freeze<MemoryBucketStatus>({
      bucketId: target.bucketId,
      currentCount,
      bucketRecordIds,
      softCap: null,
      hardCap: null,
      zone: maxTotalRecordsReached ? 'AT_HARD_CAP' : 'UNCAPPED',
      totalRecordsCount,
      maxTotalRecords,
      maxTotalRecordsReached,
    });
  }
  const softCap = winningRule.softCap;
  const hardCap = winningRule.hardCap;
  const zone =
    currentCount >= hardCap || maxTotalRecordsReached
      ? 'AT_HARD_CAP'
      : currentCount >= softCap
        ? 'SOFT_CAP_PRESSURE'
        : 'UNDER_SOFT_CAP';
  return Object.freeze<MemoryBucketStatus>({
    bucketId: target.bucketId,
    currentCount,
    bucketRecordIds,
    softCap,
    hardCap,
    zone,
    totalRecordsCount,
    maxTotalRecords,
    maxTotalRecordsReached,
  });
}
