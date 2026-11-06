import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Initial byte window read from the tail of the transcript file. */
const TAIL_BYTES = 262_144;

/** Byte window read from the start of the transcript file to detect subagent role. */
const HEAD_BYTES = 16_384;

/** Prefix sentinel identifying an injected post-compaction grounding message. */
const GROUNDING_SENTINEL_PREFIX = 'POST_COMPACTION_GROUNDING_REQUIRED:';

/** Anchored pattern matching an already-injected post-compaction grounding message. */
const GROUNDING_SENTINEL_PATTERN = /^POST_COMPACTION_GROUNDING_REQUIRED:/;

/** Ordered post-compaction grounding file sequences per harness role. */
const ROLE_GROUNDING_FILES = {
  head: [
    'CLAUDE.MD',
    'docs/rules/GENERAL.md',
    'docs/rules/HEAD.md',
    'docs/lessons/GENERAL.md',
    'docs/lessons/HEAD.md',
    'docs/SPEC.md',
    'docs/SPEC_LOOP.md',
    'docs/PLAN_LOOP.md',
    'docs/IMPL_LOOP.md',
    'docs/HARNESS_LOOP.md',
  ],
  builder: [
    'CLAUDE.MD',
    'docs/rules/GENERAL.md',
    'docs/rules/BUILDER.md',
    'docs/lessons/GENERAL.md',
    'docs/lessons/BUILDER.md',
    'docs/CODING_GUIDELINES.md',
  ],
  reviewer: [
    'CLAUDE.MD',
    'docs/rules/GENERAL.md',
    'docs/rules/REVIEWER.md',
    'docs/lessons/GENERAL.md',
    'docs/lessons/REVIEWER.md',
    'docs/CODING_GUIDELINES.md',
  ],
  verifier: [
    'CLAUDE.MD',
    'docs/rules/GENERAL.md',
    'docs/rules/VERIFIER.md',
    'docs/lessons/GENERAL.md',
    'docs/lessons/VERIFIER.md',
    'docs/CODING_GUIDELINES.md',
  ],
  distiller: [
    'CLAUDE.MD',
    'docs/rules/GENERAL.md',
    'docs/rules/DISTILLER.md',
    'docs/rules/HEAD.md',
    'docs/rules/BUILDER.md',
    'docs/rules/REVIEWER.md',
    'docs/rules/VERIFIER.md',
    'docs/lessons/GENERAL.md',
    'docs/lessons/HEAD.md',
    'docs/lessons/BUILDER.md',
    'docs/lessons/REVIEWER.md',
    'docs/lessons/VERIFIER.md',
    'docs/CODING_GUIDELINES.md',
  ],
};

/**
 * Reads the complete UTF-8 payload from standard input.
 *
 * Collects all stream chunks from `process.stdin` and concatenates them into a single string.
 *
 * @returns {Promise<string>} Complete UTF-8 string read from standard input.
 */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Reads a byte range `[start, end)` from an open file descriptor as a UTF-8 string.
 *
 * Allocates a fixed buffer for the requested slice and performs a synchronous positional read.
 *
 * @param {number} fd    - Open file descriptor to read from.
 * @param {number} start - Inclusive starting byte offset.
 * @param {number} end   - Exclusive ending byte offset.
 *
 * @returns {string} Decoded UTF-8 slice from the file.
 */
function readRange(fd, start, end) {
  const buffer = Buffer.alloc(Math.max(0, end - start));
  if (buffer.length === 0) return '';
  readSync(fd, buffer, 0, buffer.length, start);
  return buffer.toString('utf8');
}

/**
 * Checks whether a parsed JSONL transcript entry is an injected grounding message or completed read.
 *
 * Inspects non-model system message fields for the grounding sentinel and checks model tool calls
 * for completed terminal grounding file reads (`docs/HARNESS_LOOP.md` or `docs/CODING_GUIDELINES.md`).
 *
 * @param {unknown} entry - Parsed JSONL transcript object.
 *
 * @returns {boolean} `true` if grounding was already injected or completed; otherwise `false`.
 */
function isGroundedEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.type === 'PLANNER_RESPONSE' && Array.isArray(entry.tool_calls)) {
    return entry.tool_calls.some((tc) => {
      const targetPath = tc?.args?.Path ?? tc?.args?.AbsolutePath;
      return (
        (tc?.name === 'read_file' || tc?.name === 'view_file') &&
        typeof targetPath === 'string' &&
        (targetPath.includes('docs/HARNESS_LOOP.md') || targetPath.includes('docs/CODING_GUIDELINES.md'))
      );
    });
  }
  if (entry.type === 'PLANNER_RESPONSE' || entry.type === 'TOOL_RESULT' || entry.type === 'GENERIC') {
    return false;
  }
  const candidates = [
    entry.systemMessage?.systemMessage,
    entry.systemMessage,
    entry.injectSteps?.[0]?.systemMessage?.systemMessage,
    entry.reason,
    entry.content,
    entry.text,
  ];
  return candidates.some((c) => typeof c === 'string' && GROUNDING_SENTINEL_PATTERN.test(c.trim()));
}

/**
 * Scans complete JSONL lines in a transcript slice from newest to oldest for compaction state.
 *
 * Returns `'grounded'` if a grounding sentinel or completed read appears after any `CHECKPOINT`,
 * `'ungrounded'` if a `CHECKPOINT` entry is encountered first, or `'none'` if neither appears.
 *
 * @param {string}  text                   - Raw UTF-8 slice from the transcript file.
 * @param {boolean} skipLeadingPartialLine - Whether `text` begins mid-file at `start > 0`.
 *
 * @returns {'grounded' | 'ungrounded' | 'none'} Compaction grounding status for the slice.
 */
function scanCompactionState(text, skipLeadingPartialLine) {
  const firstNewline = skipLeadingPartialLine ? text.indexOf('\n') : -1;
  if (skipLeadingPartialLine && firstNewline === -1) return 'none';
  const completeText = skipLeadingPartialLine ? text.slice(firstNewline + 1) : text;
  const lines = completeText.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (isGroundedEntry(entry)) return 'grounded';
      if (entry?.type === 'CHECKPOINT') return 'ungrounded';
    } catch {
      continue;
    }
  }
  return 'none';
}

/**
 * Detects the active agent role from the opening slice of the session transcript.
 *
 * Matches subagent bootstrap role identifiers in the initial prompt and defaults to `'head'`.
 *
 * @param {string} headText - Opening UTF-8 bytes of `transcript.jsonl`.
 *
 * @returns {'head' | 'builder' | 'reviewer' | 'verifier' | 'distiller'} Detected role key.
 */
function detectRoleFromHead(headText) {
  if (headText.includes('loop-distiller') || headText.includes('Distiller bootstrap manifest')) return 'distiller';
  if (headText.includes('loop-verifier') || headText.includes('Verifier bootstrap manifest')) return 'verifier';
  if (headText.includes('loop-reviewer') || headText.includes('Reviewer bootstrap manifest')) return 'reviewer';
  if (headText.includes('loop-builder') || headText.includes('Builder bootstrap manifest')) return 'builder';
  return 'head';
}

/**
 * Inspects `transcriptPath` to determine if an ungrounded compaction `CHECKPOINT` occurred.
 *
 * Reads expanding tail windows until a `CHECKPOINT` or grounding sentinel is found, and detects
 * the session role from the head of the file when grounding is required.
 *
 * @param {string} transcriptPath - Path to the active session's `transcript.jsonl` file.
 *
 * @returns {{ needed: boolean, role: 'head' | 'builder' | 'reviewer' | 'verifier' | 'distiller' }} Grounding requirement and role.
 */
function checkCompactionGrounding(transcriptPath) {
  const fd = openSync(transcriptPath, 'r');
  try {
    const size = fstatSync(fd).size;
    for (let tail = TAIL_BYTES; ; tail *= 2) {
      const start = Math.max(0, size - tail);
      const state = scanCompactionState(readRange(fd, start, size), start > 0);
      if (state === 'grounded') return { needed: false, role: 'head' };
      if (state === 'ungrounded') {
        const headSlice = readRange(fd, 0, Math.min(size, HEAD_BYTES));
        return { needed: true, role: detectRoleFromHead(headSlice) };
      }
      if (start === 0) return { needed: false, role: 'head' };
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Loads an existing post-compaction grounding note from `.memory/` or generates and persists one.
 *
 * Reads `.memory/post-compaction.md` (for `head`) or `.memory/post-compaction-<role>.md` when
 * present; otherwise generates the role-specific sequential reading note and writes it to disk.
 *
 * @param {string} workspaceRoot - Absolute path to the workspace root directory.
 * @param {'head' | 'builder' | 'reviewer' | 'verifier' | 'distiller'} role - Active agent role.
 *
 * @returns {string} Complete post-compaction grounding instruction with sentinel prefix.
 */
function loadOrGenerateGroundingNote(workspaceRoot, role) {
  const fileName = role === 'head' ? 'post-compaction.md' : `post-compaction-${role}.md`;
  const notePath = resolve(workspaceRoot, '.memory', fileName);
  if (existsSync(notePath)) {
    const existing = readFileSync(notePath, 'utf8').trim();
    if (existing.length > 0) {
      return existing.startsWith(GROUNDING_SENTINEL_PREFIX)
        ? existing
        : `${GROUNDING_SENTINEL_PREFIX} ${existing}`;
    }
  }
  const files = ROLE_GROUNDING_FILES[role] ?? ROLE_GROUNDING_FILES.head;
  const generated = `${GROUNDING_SENTINEL_PREFIX} You were compacted. Ground yourself immediately: read ${files.join(', ')} in this exact sequence, one by one, each one fully. Do not do anything else before you finish.`;
  mkdirSync(dirname(notePath), { recursive: true });
  writeFileSync(notePath, `${generated}\n`, 'utf8');
  return generated;
}

/**
 * CLI entrypoint for the post-compaction grounding hook (`PreInvocation` and `Stop`).
 *
 * Checks `transcriptPath` for an ungrounded `CHECKPOINT` entry and injects the role's grounding
 * note from `.memory/` (or generates and saves it if missing).
 *
 * @returns {Promise<void>} Resolves after writing the hook response JSON to `stdout`.
 */
async function main() {
  const raw = await readStdin();
  const payload = raw ? JSON.parse(raw) : {};
  const isStopHook = typeof payload.terminationReason === 'string';
  if (!payload.transcriptPath) {
    process.stdout.write(isStopHook ? '{"decision":"allow"}\n' : '{}\n');
    return;
  }
  const { needed, role } = checkCompactionGrounding(payload.transcriptPath);
  if (!needed) {
    process.stdout.write(isStopHook ? '{"decision":"allow"}\n' : '{}\n');
    return;
  }
  const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const workspaceRoot = payload.workspacePaths?.[0] || defaultRoot;
  const note = loadOrGenerateGroundingNote(workspaceRoot, role);
  const response = isStopHook
    ? { decision: 'continue', reason: note }
    : { injectSteps: [{ systemMessage: { systemMessage: note } }] };
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

try {
  await main();
} catch {
  process.stdout.write('{}\n');
}
