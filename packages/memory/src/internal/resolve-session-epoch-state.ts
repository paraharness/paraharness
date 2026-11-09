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
  /** Result shape reference for single-root reachability (`Rule 1.2`). */
  readonly transcriptResultShape?: ResolvedTranscriptScanResult;
}

/**
 * Result returned by `resolveTranscriptEpochAndRole` (§7.1.2, §7.2 Step 1).
 */
export interface ResolvedTranscriptScanResult {
  /** Resolved compaction checkpoint ID (`'epoch-0'` or the latest compaction boundary ID). */
  readonly currentCheckpointId: string;
  /** Latest `memory_init` role argument discovered in the scanned transcript slice, if any. */
  readonly transcriptInitRole: string | undefined;
  /** Normalized touched paths extracted from Antigravity tool steps in the scanned slice (§7.1.2). */
  readonly extractedTouchedPaths: readonly string[];
  /** Current byte length of `transcriptPath` when readable (`undefined` when omitted or unreadable). */
  readonly transcriptByteLength: number | undefined;
  /** Whether a full rescan from byte offset `0` was performed. */
  readonly performedFullScan: boolean;
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
  /** Sub-interface reference for single-root reachability (`Rule 1.2`). */
  readonly transcriptParamsShape?: ResolveTranscriptEpochAndRoleParams;
  /** Result shape reference for single-root reachability (`Rule 1.2`). */
  readonly resultShape?: ResolvedSessionEpochStateResult;
}

/**
 * Result returned by `resolveSessionEpochState` (§7.2 Steps 1–2).
 */
export interface ResolvedSessionEpochStateResult {
  /** Updated per-session compaction epoch state. */
  readonly state: MemorySessionEpochState;
  /** Resolved active role for this session and hook invocation. */
  readonly resolvedRole: string;
  /** Active compaction checkpoint identifier. */
  readonly compactionEpochId: string;
  /** Normalized touched paths extracted from `transcript.jsonl` tool steps during the scan (§7.1.2). */
  readonly transcriptTouchedPaths: readonly string[];
  /** Whether `seenRecordIds` was reset due to a new session or compaction epoch transition. */
  readonly epochReset: boolean;
  /** Whether `PENDING_HOOK_EPOCH` was bound to `compactionEpochId` while preserving `seenRecordIds`. */
  readonly boundPendingHookEpoch: boolean;
}

/**
 * Checks whether a parsed transcript JSON object represents a compaction boundary in Antigravity
 * (`type === 'CHECKPOINT'`) or Claude Code (`type === 'compact_boundary' || subtype === 'compact_boundary'`)
 * and returns its stable boundary identifier using the fallback chain
 * `step_index ?? uuid ?? timestamp ?? created_at ?? "offset:<lineByteOffset>"` (§7.2 Step 1).
 *
 * @param {Readonly<Record<string, unknown>>} obj            - Parsed JSON object from a transcript line.
 * @param {number}                            lineByteOffset - 0-based UTF-8 byte offset of the line in `transcript.jsonl`.
 *
 * @returns {string | null} Compaction boundary identifier string, or `null` if not a boundary.
 */
function extractCompactionBoundaryId(
  obj: Readonly<Record<string, unknown>>,
  lineByteOffset: number,
): string | null {
  const isCheckpoint =
    obj['type'] === 'CHECKPOINT' ||
    obj['type'] === 'compact_boundary' ||
    obj['subtype'] === 'compact_boundary';
  if (!isCheckpoint) {
    return null;
  }
  const candidateId =
    obj['step_index'] ??
    obj['uuid'] ??
    obj['timestamp'] ??
    obj['created_at'] ??
    `offset:${lineByteOffset}`;
  return String(candidateId);
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
    for (const item of node) {
      const found = extractMemoryInitRoleFromNode(item);
      if (found !== undefined) {
        latest = found;
      }
    }
    return latest;
  }
  const rec = node as Readonly<Record<string, unknown>>;
  const rawName = rec['tool_name'] ?? rec['toolName'] ?? rec['name'] ?? rec['tool'];
  const toolName = typeof rawName === 'string' ? rawName.trim() : '';
  if (toolName === 'memory_init' || toolName.endsWith('__memory_init')) {
    const rawInput =
      rec['tool_input'] ?? rec['toolInput'] ?? rec['input'] ?? rec['arguments'] ?? rec['args'] ?? rec;
    if (typeof rawInput === 'string') {
      try {
        const parsed: unknown = JSON.parse(rawInput);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const roleVal = (parsed as Readonly<Record<string, unknown>>)['role'];
          if (typeof roleVal === 'string' && roleVal.trim().length > 0) {
            return roleVal.trim();
          }
        }
      } catch {
        return undefined;
      }
    } else if (rawInput !== null && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
      const roleVal = (rawInput as Readonly<Record<string, unknown>>)['role'];
      if (typeof roleVal === 'string' && roleVal.trim().length > 0) {
        return roleVal.trim();
      }
    }
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
    const obj = parsed as Readonly<Record<string, unknown>>;
    const boundaryId = extractCompactionBoundaryId(obj, currentLineOffset);
    if (boundaryId !== null) {
      latestBoundaryId = boundaryId;
      touchedSet = new Set<string>();
    }
    const initRole = extractMemoryInitRoleFromNode(obj);
    if (initRole !== undefined) {
      latestInitRole = initRole;
    }
    if (currentLineOffset >= toolTouchMinimumOffset) {
      const stepPaths = extractTouchedPathsFromHookInput(obj, params.workspaceRoot);
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
 * @param {MemoryConfig}            config             - Validated unified memory configuration.
 * @param {string | undefined}      explicitRole       - Optional explicit role passed by caller.
 * @param {string | undefined}      transcriptInitRole - Role discovered from `memory_init` in `transcript.jsonl`.
 * @param {MemorySessionEpochState} [existingState]    - Existing `<sessionId>.json` state, if any.
 * @param {string}                  sessionStateDir    - Absolute path to `.memory/.session-state`.
 *
 * @returns {string} Validated role present in `config.allowedRoles`.
 */
function selectFallbackRole(
  config: MemoryConfig,
  explicitRole: string | undefined,
  transcriptInitRole: string | undefined,
  existingState: MemorySessionEpochState | undefined,
  sessionStateDir: string,
): string {
  if (explicitRole !== undefined) {
    return explicitRole;
  }
  const allowed = new Set(config.allowedRoles);
  if (transcriptInitRole !== undefined && allowed.has(transcriptInitRole)) {
    return transcriptInitRole;
  }
  if (
    existingState !== undefined &&
    existingState.role !== 'general' &&
    allowed.has(existingState.role)
  ) {
    return existingState.role;
  }
  const latestRole = readLatestRoleFallback(sessionStateDir);
  if (latestRole !== undefined && allowed.has(latestRole)) {
    return latestRole;
  }
  if (existingState !== undefined && allowed.has(existingState.role)) {
    return existingState.role;
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
  const resolvedRole = selectFallbackRole(
    params.config,
    params.role,
    scanResult.transcriptInitRole,
    existingState,
    sessionStateDir,
  );
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
