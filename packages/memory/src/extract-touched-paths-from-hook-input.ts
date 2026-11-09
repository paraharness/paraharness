import {
  CONSECUTIVE_SLASHES_REGEX,
  FILE_INTERACTION_TOOL_NAMES,
  LEADING_SLASHES_REGEX,
  TRAILING_SLASHES_REGEX,
  WINDOWS_DRIVE_SLASH_REGEX,
} from './internal/memory-protocol.constants.js';
import { normalizeMemoryPathPattern } from './internal/normalize-memory-path-pattern.js';

/**
 * Joins a directory path and a glob pattern into a single raw POSIX path string before calling
 * `normalizeMemoryPathPattern` (§7.1.1, §7.1.2).
 *
 * @param {string} rawDir     - Raw directory path (defaults to `'.'` when empty).
 * @param {string} rawPattern - Raw glob or filename pattern.
 *
 * @returns {string} Joined raw directory + pattern string.
 */
function joinRawDirAndPattern(rawDir: string, rawPattern: string): string {
  const cleanDir = rawDir.trim().replace(TRAILING_SLASHES_REGEX, '');
  const cleanPattern = rawPattern.trim().replace(LEADING_SLASHES_REGEX, '');
  const effectiveDir = cleanDir.length > 0 ? cleanDir : '.';
  return `${effectiveDir}/${cleanPattern}`;
}

/**
 * Extracts non-empty string values from a candidate scalar or string-array property.
 *
 * @param {unknown} value - Property value to inspect.
 *
 * @returns {readonly string[]} Trimmed non-empty string values.
 */
function toNonEmptyStrings(value: unknown): readonly string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const element of value) {
      if (typeof element === 'string' && element.trim().length > 0) {
        out.push(element.trim());
      }
    }
    return out;
  }
  return [];
}

/**
 * Extracts raw path/glob candidates from a single normalized `(toolName, toolInput)` pair across
 * Claude Code (`Read`, `Edit`, `MultiEdit`, `Write`, `NotebookEdit`, `Glob`, `Grep`) and
 * Antigravity (`read_file`, `view_file`, `view_file_outline`, `view_code_item`, `edit_file`,
 * `write_file`, `write_to_file`, `replace_file_content`, `multi_replace_file_content`,
 * `find_by_name`, `grep_search`) tool invocations (§7.1.1–§7.1.2).
 *
 * @param {string}                            toolName  - Tool identifier (`tool_name`, `toolName`, or `name`).
 * @param {Readonly<Record<string, unknown>>} toolInput - Tool input arguments object.
 *
 * @returns {readonly string[]} Raw candidate path or glob strings prior to workspace normalization.
 */
function extractRawCandidatesForTool(
  toolName: string,
  toolInput: Readonly<Record<string, unknown>>,
): readonly string[] {
  if (toolName === 'Glob') {
    const rawPath = toNonEmptyStrings(toolInput['path'])[0];
    const rawPattern = toNonEmptyStrings(toolInput['pattern'])[0];
    if (rawPath !== undefined && rawPattern !== undefined) {
      return [joinRawDirAndPattern(rawPath, rawPattern)];
    }
    if (rawPattern !== undefined) return [rawPattern];
    if (rawPath !== undefined) return [rawPath];
    return [];
  }
  if (toolName === 'Grep') {
    const rawGlob = toNonEmptyStrings(toolInput['glob'])[0];
    const rawPath = toNonEmptyStrings(toolInput['path'])[0] ?? '.';
    if (rawGlob !== undefined) {
      return [joinRawDirAndPattern(rawPath, rawGlob)];
    }
    return [rawPath];
  }
  if (toolName === 'find_by_name') {
    const rawPattern =
      toNonEmptyStrings(toolInput['Pattern'])[0] ?? toNonEmptyStrings(toolInput['pattern'])[0];
    const rawDir =
      toNonEmptyStrings(toolInput['SearchDirectory'])[0] ??
      toNonEmptyStrings(toolInput['DirectoryPath'])[0] ??
      toNonEmptyStrings(toolInput['path'])[0] ??
      '.';
    if (rawPattern !== undefined) {
      return [joinRawDirAndPattern(rawDir, rawPattern)];
    }
    return [rawDir];
  }
  if (toolName === 'grep_search') {
    const includes = [
      ...toNonEmptyStrings(toolInput['Includes']),
      ...toNonEmptyStrings(toolInput['includes']),
    ];
    const rawDir =
      toNonEmptyStrings(toolInput['SearchPath'])[0] ??
      toNonEmptyStrings(toolInput['SearchDirectory'])[0] ??
      toNonEmptyStrings(toolInput['path'])[0] ??
      '.';
    if (includes.length > 0) {
      const joined: string[] = [];
      for (const inc of includes) {
        joined.push(joinRawDirAndPattern(rawDir, inc));
      }
      return joined;
    }
    return [rawDir];
  }
  if (toolName === 'NotebookEdit') {
    return [
      ...toNonEmptyStrings(toolInput['notebook_path']),
      ...toNonEmptyStrings(toolInput['file_path']),
    ];
  }
  if (FILE_INTERACTION_TOOL_NAMES.has(toolName) || toolName.length === 0) {
    return [
      ...toNonEmptyStrings(toolInput['file_path']),
      ...toNonEmptyStrings(toolInput['notebook_path']),
      ...toNonEmptyStrings(toolInput['AbsolutePath']),
      ...toNonEmptyStrings(toolInput['File']),
      ...toNonEmptyStrings(toolInput['TargetFile']),
      ...toNonEmptyStrings(toolInput['path']),
      ...toNonEmptyStrings(toolInput['paths']),
      ...toNonEmptyStrings(toolInput['Paths']),
    ];
  }
  return [];
}

/**
 * Resolves a tool input object from `nestedInputRaw` (parsing JSON strings when valid) or falls back
 * to `rec` when `toolName` is present on the record itself.
 *
 * @param {unknown}                           nestedInputRaw - Candidate `tool_input` / `input` / `arguments` property.
 * @param {string}                            toolName       - Resolved tool name on `rec`.
 * @param {Readonly<Record<string, unknown>>} rec            - Enclosing record object.
 *
 * @returns {Readonly<Record<string, unknown>> | null} Resolved tool input record, or `null` if none applies.
 */
function resolveToolInputObject(
  nestedInputRaw: unknown,
  toolName: string,
  rec: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | null {
  if (typeof nestedInputRaw === 'string') {
    try {
      const parsedArgs: unknown = JSON.parse(nestedInputRaw);
      if (parsedArgs !== null && typeof parsedArgs === 'object' && !Array.isArray(parsedArgs)) {
        return parsedArgs as Readonly<Record<string, unknown>>;
      }
      return null;
    } catch {
      return null;
    }
  }
  if (
    nestedInputRaw !== null &&
    typeof nestedInputRaw === 'object' &&
    !Array.isArray(nestedInputRaw)
  ) {
    return nestedInputRaw as Readonly<Record<string, unknown>>;
  }
  if (toolName.length > 0) {
    return rec;
  }
  return null;
}

/**
 * Recursively collects raw path/glob candidates from hook payloads or transcript step objects.
 *
 * @param {unknown}  node - Hook input object or transcript JSON entry.
 * @param {string[]} out  - Mutable accumulator receiving raw path/glob strings.
 *
 * @returns {void}
 */
function collectRawCandidatesFromPayload(node: unknown, out: string[]): void {
  if (node === null || typeof node !== 'object') {
    return;
  }
  if (Array.isArray(node)) {
    for (const childNode of node) {
      collectRawCandidatesFromPayload(childNode, out);
    }
    return;
  }
  const rec = node as Readonly<Record<string, unknown>>;
  const toolNameRaw = rec['tool_name'] ?? rec['toolName'] ?? rec['name'] ?? rec['tool'];
  const toolName = typeof toolNameRaw === 'string' ? toolNameRaw.trim() : '';
  const nestedInputRaw =
    rec['tool_input'] ?? rec['toolInput'] ?? rec['input'] ?? rec['arguments'] ?? rec['args'];
  const resolvedInput = resolveToolInputObject(nestedInputRaw, toolName, rec);
  if (resolvedInput !== null) {
    for (const candidate of extractRawCandidatesForTool(toolName, resolvedInput)) {
      out.push(candidate);
    }
  }
  const nestedContainers = [
    rec['message'],
    rec['content'],
    rec['toolCalls'],
    rec['tool_calls'],
    rec['step'],
    rec['steps'],
  ];
  for (const container of nestedContainers) {
    if (container !== undefined) {
      collectRawCandidatesFromPayload(container, out);
    }
  }
}

/**
 * Normalizes a single raw candidate path/glob string using `normalizeMemoryPathPattern` when
 * `workspaceRoot` is supplied or when the candidate is relative.
 *
 * @param {string} rawCandidate    - Raw candidate path or glob extracted from tool input.
 * @param {string} [workspaceRoot] - Optional workspace root directory for stripping absolute prefixes.
 *
 * @returns {string | null} Normalized path/glob string, or `null` if invalid/outside `workspaceRoot`.
 */
function normalizeExtractedCandidate(
  rawCandidate: string,
  workspaceRoot?: string,
): string | null {
  if (workspaceRoot !== undefined) {
    try {
      return normalizeMemoryPathPattern(rawCandidate, workspaceRoot);
    } catch {
      return null;
    }
  }
  const posix = rawCandidate.trim().replaceAll('\\', '/').replace(CONSECUTIVE_SLASHES_REGEX, '/');
  if (posix.startsWith('/') || WINDOWS_DRIVE_SLASH_REGEX.test(posix)) {
    const cleaned = posix.replace(TRAILING_SLASHES_REGEX, '');
    const segments = cleaned.split('/');
    if (segments.some((seg) => seg === '..')) {
      return null;
    }
    return cleaned.length > 0 ? cleaned : '/';
  }
  try {
    return normalizeMemoryPathPattern(rawCandidate, '/');
  } catch {
    return null;
  }
}

/**
 * Extracts and normalizes touched file paths, directory paths, and joined directory+glob patterns
 * from Claude Code (`PreToolUse`/`PostToolUse` `Read`, `Edit`, `MultiEdit`, `Write`, `NotebookEdit`,
 * `Glob`, `Grep`) and Antigravity (`read_file`, `view_file`, `view_file_outline`, `view_code_item`,
 * `edit_file`, `write_file`, `write_to_file`, `replace_file_content`, `multi_replace_file_content`,
 * `find_by_name`, `grep_search`) hook or transcript tool-step payloads (§7.1.1–§7.1.2).
 *
 * @param {unknown} hookPayload     - Raw hook input or transcript step object.
 * @param {string}  [workspaceRoot] - Optional workspace root directory used to normalize absolute paths into workspace-relative POSIX form.
 *
 * @returns {readonly string[]} Frozen deduplicated array of normalized touched paths/globs in first-seen order.
 */
export function extractTouchedPathsFromHookInput(
  hookPayload: unknown,
  workspaceRoot?: string,
): readonly string[] {
  const rawCandidates: string[] = [];
  collectRawCandidatesFromPayload(hookPayload, rawCandidates);
  const seen = new Set<string>();
  const normalizedList: string[] = [];
  for (const rawCandidate of rawCandidates) {
    const normalized = normalizeExtractedCandidate(rawCandidate, workspaceRoot);
    if (normalized !== null && !seen.has(normalized)) {
      seen.add(normalized);
      normalizedList.push(normalized);
    }
  }
  return Object.freeze(normalizedList);
}
