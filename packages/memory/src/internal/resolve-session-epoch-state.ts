import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import { extractTouchedPathsFromHookInput } from '../extract-touched-paths-from-hook-input.js';
import { MemoryHarnessError } from '../memory-harness-error.js';
import type { MemoryConfig } from '../schemas/memory-config.schema.js';
import {
  MemoryLatestRoleStateSchema,
  MemorySessionEpochStateSchema,
  SessionIdSchema,
  type MemorySessionEpochState,
} from '../schemas/memory-tools.schema.js';
import {
  INITIAL_COMPACTION_EPOCH,
  LATEST_ROLE_FILENAME,
  PENDING_HOOK_EPOCH,
  SESSION_STATE_REL_DIR,
} from './memory-protocol.constants.js';
import type { ResolvedSessionEpochStateResult } from './resolved-session-epoch-state-result.js';
import type { ResolvedTranscriptScanResult } from './resolved-transcript-scan-result.js';

/**
 * Parameter object for `resolveTranscriptEpochAndRole`.
 */
export interface ResolveTranscriptEpochAndRoleParams {
  /** Absolute path to the workspace root directory. */
  readonly workspaceRoot: string;
  /** Optional path to `transcript.jsonl`. */
  readonly transcriptPath?: string;
  /** Existing session epoch state loaded from `<sessionId>.json`, if present. */
  readonly existingState?: MemorySessionEpochState;
}

/**
 * Parameter object for `resolveSessionEpochState`.
 */
export interface ResolveSessionEpochStateParams {
  /** Absolute path to the workspace root directory. */
  readonly workspaceRoot: string;
  /** Validated unified memory configuration. */
  readonly config: MemoryConfig;
  /** Validated session identifier. */
  readonly sessionId: string;
  /** Optional explicit caller role (`input.role`). */
  readonly role?: string;
  /** Optional path to `transcript.jsonl`. */
  readonly transcriptPath?: string;
  /** Whether to immediately persist the updated `<sessionId>.json` to disk (`defaults to true`). */
  readonly persistState?: boolean;
  /** Optional UTC timestamp override in epoch milliseconds. */
  readonly nowMs?: number;
}

/**
 * Parameter object for `selectFallbackRole`.
 */
export interface SelectFallbackRoleParams {
  /** Validated unified memory configuration. */
  readonly config: MemoryConfig;
  /** Optional explicit role passed by caller. */
  readonly explicitRole?: string;
  /** Role discovered from `memory_init` in `transcript.jsonl`, if any. */
  readonly transcriptInitRole?: string;
  /** Existing `<sessionId>.json` state, if any. */
  readonly existingState?: MemorySessionEpochState;
  /** Absolute path to `.memory/.session-state`. */
  readonly sessionStateDir: string;
}

/**
 * Checks whether a parsed transcript JSON object represents a compaction boundary in Antigravity
 * (`type === 'CHECKPOINT'`) or Claude Code (`type === 'compact_boundary' || subtype === 'compact_boundary'`)
 * and returns its stable boundary identifier using the fallback chain
 * `step_index ?? uuid ?? timestamp ?? created_at ?? "offset:<lineByteOffset>"` (§7.2 Step 1).
 *
 * @param {Readonly<Record<string, unknown>>} entryRecord    - Parsed JSON object from a transcript line.
 * @param {number}                            lineByteOffset - 0-based UTF-8 byte offset of the line in `transcript.jsonl`.
 *
 * @returns {string | null} Compaction boundary identifier string, or `null` if not a boundary.
 */
function extractCompactionBoundaryId(
  entryRecord: Readonly<Record<string, unknown>>,
  lineByteOffset: number,
): string | null {
  const isCheckpoint =
    entryRecord['type'] === 'CHECKPOINT' ||
    entryRecord['type'] === 'compact_boundary' ||
    entryRecord['subtype'] === 'compact_boundary';
  if (!isCheckpoint) {
    return null;
  }
  const candidateId =
    entryRecord['step_index'] ??
    entryRecord['uuid'] ??
    entryRecord['timestamp'] ??
    entryRecord['created_at'] ??
    `offset:${lineByteOffset}`;
  return String(candidateId);
}

/**
 * Resolves a candidate tool input value (JSON string or plain object) into a plain record object,
 * returning `null` if parsing fails or the value is not a non-array object.
 *
 * @param {unknown} rawInput - Candidate `tool_input` / `input` / `arguments` property value.
 *
 * @returns {Readonly<Record<string, unknown>> | null} Plain record object or `null`.
 */
function parseRecordObjectCandidate(
  rawInput: unknown,
): Readonly<Record<string, unknown>> | null {
  if (typeof rawInput === 'string') {
    try {
      const parsed: unknown = JSON.parse(rawInput);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Readonly<Record<string, unknown>>;
      }
      return null;
    } catch {
      return null;
    }
  }
  if (rawInput !== null && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    return rawInput as Readonly<Record<string, unknown>>;
  }
  return null;
}

/**
 * Extracts a direct `memory_init` `role` argument from a single record object when its tool name
 * matches `memory_init` or `*__memory_init`.
 *
 * @param {Readonly<Record<string, unknown>>} rec - Record object to inspect.
 *
 * @returns {string | undefined} Trimmed `role` string, or `undefined` if not a `memory_init` call.
 */
function extractDirectMemoryInitRole(
  rec: Readonly<Record<string, unknown>>,
): string | undefined {
  const rawName = rec['tool_name'] ?? rec['toolName'] ?? rec['name'] ?? rec['tool'];
  const toolName = typeof rawName === 'string' ? rawName.trim() : '';
  if (toolName !== 'memory_init' && !toolName.endsWith('__memory_init')) {
    return undefined;
  }
  const rawInput =
    rec['tool_input'] ?? rec['toolInput'] ?? rec['input'] ?? rec['arguments'] ?? rec['args'] ?? rec;
  const parsedObj = parseRecordObjectCandidate(rawInput);
  if (parsedObj === null) {
    return undefined;
  }
  const roleVal = parsedObj['role'];
  if (typeof roleVal === 'string' && roleVal.trim().length > 0) {
    return roleVal.trim();
  }
  return undefined;
}

/**
 * Recursively inspects a parsed transcript JSON node for a `memory_init` tool invocation and
 * extracts its `role` argument if present (§7.2 Step 1).
 *
 * @param {unknown} node - Parsed JSON value from a transcript line.
 *
 * @returns {string | undefined} Extracted `role` string from `memory_init`, or `undefined`.
 */
function extractMemoryInitRoleFromNode(node: unknown): string | undefined {
  if (node === null || typeof node !== 'object') {
    return undefined;
  }
  if (Array.isArray(node)) {
    let latest: string | undefined;
    for (const childNode of node) {
      const found = extractMemoryInitRoleFromNode(childNode);
      if (found !== undefined) {
        latest = found;
      }
    }
    return latest;
  }
  const rec = node as Readonly<Record<string, unknown>>;
  const directRole = extractDirectMemoryInitRole(rec);
  if (directRole !== undefined) {
    return directRole;
  }
  const nestedKeys = ['message', 'content', 'toolCalls', 'tool_calls', 'step', 'steps'];
  let latestNested: string | undefined;
  for (const key of nestedKeys) {
    if (rec[key] !== undefined) {
      const found = extractMemoryInitRoleFromNode(rec[key]);
      if (found !== undefined) {
        latestNested = found;
      }
    }
  }
  return latestNested;
}

/**
 * Scans `transcriptPath` (from byte offset `0` on full-rescan triggers or incrementally from
 * `existingState.lastScannedTranscriptOffset`) to resolve the current compaction checkpoint ID,
 * latest `memory_init` role argument, and Antigravity tool-step touched paths (§7.1.2, §7.2 Step 1).
 *
 * @param {ResolveTranscriptEpochAndRoleParams} params - Workspace root, optional `transcriptPath`, and `existingState`.
 *
 * @returns {ResolvedTranscriptScanResult} Checkpoint ID, discovered `memory_init` role, touched paths, and byte offset.
 */
export function resolveTranscriptEpochAndRole(
  params: ResolveTranscriptEpochAndRoleParams,
): ResolvedTranscriptScanResult {
  const existing = params.existingState;
  const fallbackCheckpointId =
    existing !== undefined && existing.lastCompactionCheckpointId !== PENDING_HOOK_EPOCH
      ? existing.lastCompactionCheckpointId
      : INITIAL_COMPACTION_EPOCH;
  if (params.transcriptPath === undefined) {
    return Object.freeze<ResolvedTranscriptScanResult>({
      currentCheckpointId: fallbackCheckpointId,
      transcriptInitRole: undefined,
      extractedTouchedPaths: Object.freeze([]),
      transcriptByteLength: undefined,
      performedFullScan: false,
    });
  }
  const resolvedTranscriptPath = path.resolve(params.workspaceRoot, params.transcriptPath);
  if (!existsSync(resolvedTranscriptPath)) {
    return Object.freeze<ResolvedTranscriptScanResult>({
      currentCheckpointId: fallbackCheckpointId,
      transcriptInitRole: undefined,
      extractedTouchedPaths: Object.freeze([]),
      transcriptByteLength: undefined,
      performedFullScan: false,
    });
  }
  let buffer: Buffer;
  try {
    buffer = readFileSync(resolvedTranscriptPath);
  } catch {
    return Object.freeze<ResolvedTranscriptScanResult>({
      currentCheckpointId: fallbackCheckpointId,
      transcriptInitRole: undefined,
      extractedTouchedPaths: Object.freeze([]),
      transcriptByteLength: undefined,
      performedFullScan: false,
    });
  }
  const transcriptByteLength = buffer.byteLength;
  const needsFullScan =
    existing === undefined ||
    existing.lastCompactionCheckpointId === PENDING_HOOK_EPOCH ||
    existing.transcriptPath !== params.transcriptPath ||
    transcriptByteLength < existing.lastScannedTranscriptOffset;
  const scanStartOffset = needsFullScan ? 0 : existing.lastScannedTranscriptOffset;
  const toolTouchMinimumOffset =
    needsFullScan &&
    existing !== undefined &&
    existing.transcriptPath === params.transcriptPath &&
    transcriptByteLength >= existing.lastScannedTranscriptOffset
      ? existing.lastScannedTranscriptOffset
      : 0;
  let latestBoundaryId: string | undefined;
  let latestInitRole: string | undefined;
  let touchedSet = new Set<string>();
  let lineStart = scanStartOffset;
  while (lineStart < transcriptByteLength) {
    const newlineIdx = buffer.indexOf(0x0a, lineStart);
    const lineEnd = newlineIdx === -1 ? transcriptByteLength : newlineIdx;
    const rawLine = buffer.subarray(lineStart, lineEnd).toString('utf8').trim();
    const currentLineOffset = lineStart;
    lineStart = newlineIdx === -1 ? transcriptByteLength : newlineIdx + 1;
    if (rawLine.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      continue;
    }
    const entryRecord = parsed as Readonly<Record<string, unknown>>;
    const boundaryId = extractCompactionBoundaryId(entryRecord, currentLineOffset);
    if (boundaryId !== null) {
      latestBoundaryId = boundaryId;
      touchedSet = new Set<string>();
    }
    const initRole = extractMemoryInitRoleFromNode(entryRecord);
    if (initRole !== undefined) {
      latestInitRole = initRole;
    }
    if (currentLineOffset >= toolTouchMinimumOffset) {
      const stepPaths = extractTouchedPathsFromHookInput(entryRecord, params.workspaceRoot);
      for (const p of stepPaths) {
        touchedSet.add(p);
      }
    }
  }
  const currentCheckpointId = needsFullScan
    ? (latestBoundaryId ?? INITIAL_COMPACTION_EPOCH)
    : (latestBoundaryId ?? existing.lastCompactionCheckpointId);
  return Object.freeze<ResolvedTranscriptScanResult>({
    currentCheckpointId,
    transcriptInitRole: latestInitRole,
    extractedTouchedPaths: Object.freeze([...touchedSet]),
    transcriptByteLength,
    performedFullScan: needsFullScan,
  });
}

/**
 * Reads `.memory/.session-state/latest-role.json` read-only if present on disk (§7.2 Step 1c).
 *
 * @param {string} sessionStateDir - Absolute path to `.memory/.session-state`.
 *
 * @returns {string | undefined} Validated role string from `latest-role.json`, or `undefined`.
 */
function readLatestRoleFallback(sessionStateDir: string): string | undefined {
  const latestRolePath = path.join(sessionStateDir, LATEST_ROLE_FILENAME);
  if (!existsSync(latestRolePath)) {
    return undefined;
  }
  try {
    const parsed = MemoryLatestRoleStateSchema.safeParse(
      JSON.parse(readFileSync(latestRolePath, 'utf8')),
    );
    return parsed.success ? parsed.data.role : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolves the active role according to the 5-step fallback precedence in §7.2 Step 1:
 * explicit `input.role` -> (a) transcript `memory_init` role -> (b) non-`'general'` `state.role` ->
 * (c) `latest-role.json` -> (d) `state.role` -> (e) `'general'`.
 *
 * @param {SelectFallbackRoleParams} params - Config, explicit/transcript/existing roles, and `sessionStateDir`.
 *
 * @returns {string} Validated role present in `config.allowedRoles`.
 */
function selectFallbackRole(params: SelectFallbackRoleParams): string {
  if (params.explicitRole !== undefined) {
    return params.explicitRole;
  }
  const allowed = new Set(params.config.allowedRoles);
  if (params.transcriptInitRole !== undefined && allowed.has(params.transcriptInitRole)) {
    return params.transcriptInitRole;
  }
  if (
    params.existingState !== undefined &&
    params.existingState.role !== 'general' &&
    allowed.has(params.existingState.role)
  ) {
    return params.existingState.role;
  }
  const latestRole = readLatestRoleFallback(params.sessionStateDir);
  if (latestRole !== undefined && allowed.has(latestRole)) {
    return latestRole;
  }
  if (params.existingState !== undefined && allowed.has(params.existingState.role)) {
    return params.existingState.role;
  }
  return 'general';
}

/**
 * Atomically persists a `MemorySessionEpochState` to `.memory/.session-state/<sessionId>.json`
 * inside an already-held `<sessionId>.lock` (§7.2, §8.1 Rule 2).
 *
 * @param {string}                  workspaceRoot - Absolute path to the workspace root directory.
 * @param {MemorySessionEpochState} state         - Validated session epoch state to persist.
 *
 * @returns {Promise<void>} Resolves once `<sessionId>.json` has been written atomically.
 */
export async function persistSessionEpochState(
  workspaceRoot: string,
  state: MemorySessionEpochState,
): Promise<void> {
  const sessionStateDir = path.resolve(workspaceRoot, SESSION_STATE_REL_DIR);
  await mkdir(sessionStateDir, { recursive: true });
  const statePath = path.join(sessionStateDir, `${state.sessionId}.json`);
  await writeFileAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8' });
}

/**
 * Executes inside an already-held `.memory/.session-state/<sessionId>.lock` (never acquiring locks
 * itself), running `resolveTranscriptEpochAndRole`, applying the 5-tier role fallback chain (reading
 * `latest-role.json` read-only), and transitioning/persisting `.memory/.session-state/<sessionId>.json`
 * per §7.1.2 and §7.2.
 *
 * @param {ResolveSessionEpochStateParams} params - Workspace root, config, `sessionId`, optional `role` and `transcriptPath`.
 *
 * @returns {Promise<ResolvedSessionEpochStateResult>} Updated session epoch state, resolved role, checkpoint ID, and transcript touched paths.
 *
 * @throws {MemoryHarnessError} With `'VALIDATION_FAILED'` on invalid `sessionId` or `'INVALID_ROLE'` on disallowed `role`.
 */
export async function resolveSessionEpochState(
  params: ResolveSessionEpochStateParams,
): Promise<ResolvedSessionEpochStateResult> {
  const parsedSid = SessionIdSchema.safeParse(params.sessionId);
  if (!parsedSid.success) {
    throw new MemoryHarnessError(
      'VALIDATION_FAILED',
      `Invalid sessionId '${params.sessionId}': ${parsedSid.error.message}`,
      { sessionId: params.sessionId, issues: parsedSid.error.issues },
    );
  }
  if (params.role !== undefined && !params.config.allowedRoles.includes(params.role)) {
    throw new MemoryHarnessError(
      'INVALID_ROLE',
      `Role '${params.role}' is not in allowedRoles (${params.config.allowedRoles.join(', ')}).`,
      { role: params.role, allowedRoles: params.config.allowedRoles },
    );
  }
  const sessionStateDir = path.resolve(params.workspaceRoot, SESSION_STATE_REL_DIR);
  const statePath = path.join(sessionStateDir, `${params.sessionId}.json`);
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
  const scanResult = resolveTranscriptEpochAndRole({
    workspaceRoot: params.workspaceRoot,
    transcriptPath: params.transcriptPath,
    existingState,
  });
  const resolvedRole = selectFallbackRole({
    config: params.config,
    explicitRole: params.role,
    transcriptInitRole: scanResult.transcriptInitRole,
    existingState,
    sessionStateDir,
  });
  const currentCheckpointId = scanResult.currentCheckpointId;
  let seenRecordIds: string[];
  let epochReset = false;
  let boundPendingHookEpoch = false;
  if (
    existingState !== undefined &&
    existingState.lastCompactionCheckpointId === PENDING_HOOK_EPOCH
  ) {
    seenRecordIds = [...existingState.seenRecordIds];
    boundPendingHookEpoch = true;
  } else if (
    existingState === undefined ||
    existingState.lastCompactionCheckpointId !== currentCheckpointId
  ) {
    seenRecordIds = [];
    epochReset = true;
  } else {
    seenRecordIds = [...existingState.seenRecordIds];
  }
  const nowIso = new Date(params.nowMs ?? Date.now()).toISOString();
  const nextTranscriptPath = params.transcriptPath ?? existingState?.transcriptPath;
  const nextOffset =
    scanResult.transcriptByteLength !== undefined
      ? scanResult.transcriptByteLength
      : (existingState?.lastScannedTranscriptOffset ?? 0);
  const nextState: MemorySessionEpochState = Object.freeze({
    sessionId: params.sessionId,
    role: resolvedRole,
    lastCompactionCheckpointId: currentCheckpointId,
    seenRecordIds,
    lastScannedTranscriptOffset: nextOffset,
    transcriptPath: nextTranscriptPath,
    updatedAt: nowIso,
  });
  if (params.persistState !== false) {
    await persistSessionEpochState(params.workspaceRoot, nextState);
  }
  return Object.freeze<ResolvedSessionEpochStateResult>({
    state: nextState,
    resolvedRole,
    compactionEpochId: currentCheckpointId,
    transcriptTouchedPaths: scanResult.extractedTouchedPaths,
    epochReset,
    boundPendingHookEpoch,
  });
}
