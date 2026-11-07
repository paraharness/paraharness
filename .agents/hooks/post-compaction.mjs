import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Initial byte window read from the tail of the transcript file. */
const TAIL_BYTES = 262_144;

/** Byte window read from the start of the transcript file to detect subagent role. */
const HEAD_BYTES = 16_384;

/** Prefix sentinel identifying an injected post-compaction grounding message. */
const GROUNDING_SENTINEL_PREFIX = 'POST_COMPACTION_GROUNDING_REQUIRED:';

/** Tool names recognized as valid manifest file-reading actions. */
const GROUNDING_TOOLS = new Set(['read_file', 'view_file']);

/** Ordered post-compaction grounding file sequences per harness role. */
const ROLE_GROUNDING_FILES = {
  head: ['CLAUDE.MD', 'docs/rules/GENERAL.md', 'docs/rules/HEAD.md', 'docs/lessons/GENERAL.md', 'docs/lessons/HEAD.md', 'docs/SPEC.md', 'and the single active docs/*_LOOP.md'],
  builder: ['CLAUDE.MD', 'docs/rules/GENERAL.md', 'docs/rules/BUILDER.md', 'docs/lessons/GENERAL.md', 'docs/lessons/BUILDER.md', 'docs/CODING_GUIDELINES.md'],
  reviewer: ['CLAUDE.MD', 'docs/rules/GENERAL.md', 'docs/rules/REVIEWER.md', 'docs/lessons/GENERAL.md', 'docs/lessons/REVIEWER.md', 'docs/CODING_GUIDELINES.md'],
  verifier: ['CLAUDE.MD', 'docs/rules/GENERAL.md', 'docs/rules/VERIFIER.md', 'docs/lessons/GENERAL.md', 'docs/lessons/VERIFIER.md', 'docs/CODING_GUIDELINES.md'],
  distiller: [
    'CLAUDE.MD', 'docs/rules/GENERAL.md', 'docs/rules/DISTILLER.md', 'docs/rules/HEAD.md', 'docs/rules/BUILDER.md', 'docs/rules/REVIEWER.md', 'docs/rules/VERIFIER.md',
    'docs/lessons/GENERAL.md', 'docs/lessons/HEAD.md', 'docs/lessons/BUILDER.md', 'docs/lessons/REVIEWER.md', 'docs/lessons/VERIFIER.md', 'docs/CODING_GUIDELINES.md',
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
 * Checks whether a parsed JSONL transcript entry contains a qualifying manifest read tool call.
 *
 * Requires a `PLANNER_RESPONSE` tool call in `GROUNDING_TOOLS` targeting the role's terminal
 * manifest file on `Stop` (`_LOOP.md` for `head`, `docs/CODING_GUIDELINES.md` for subagents),
 * or `CLAUDE.MD` / the terminal manifest file on `PreInvocation`.
 *
 * @param {unknown} entry      - Parsed JSONL transcript object.
 * @param {string}  role       - Detected harness role for the session.
 * @param {boolean} isStopHook - Whether the current invocation is a `Stop` hook event.
 *
 * @returns {boolean} `true` if a qualifying manifest read tool call occurred; otherwise `false`.
 */
function isGroundedEntry(entry, role, isStopHook) {
  if (!entry || typeof entry !== 'object' || entry.type !== 'PLANNER_RESPONSE' || !Array.isArray(entry.tool_calls)) return false;
  return entry.tool_calls.some((tc) => {
    const rawPath = tc?.args?.Path ?? tc?.args?.AbsolutePath;
    if (!GROUNDING_TOOLS.has(tc?.name) || typeof rawPath !== 'string') return false;
    const targetPath = rawPath.replace(/^"+|"+$/g, '');
    const isTerminal = role === 'head' ? targetPath.endsWith('_LOOP.md') : targetPath.includes('docs/CODING_GUIDELINES.md');
    if (isStopHook) return isTerminal;
    return isTerminal || targetPath.endsWith('CLAUDE.MD') || targetPath.endsWith('CLAUDE.md');
  });
}

/**
 * Scans complete JSONL lines in a transcript slice from newest to oldest for compaction state.
 *
 * Returns `'grounded'` if a qualifying manifest read tool call appears after any `CHECKPOINT`,
 * `'ungrounded'` if a `CHECKPOINT` entry is encountered first, or `'none'` if neither appears.
 *
 * @param {string}  text       - Complete JSONL lines from the transcript tail window.
 * @param {string}  role       - Detected harness role for the session.
 * @param {boolean} isStopHook - Whether the current invocation is a `Stop` hook event.
 *
 * @returns {'grounded' | 'ungrounded' | 'none'} Compaction grounding status for the slice.
 */
function scanCompactionState(text, role, isStopHook) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (isGroundedEntry(entry, role, isStopHook)) return 'grounded';
      if (entry?.type === 'CHECKPOINT') return 'ungrounded';
    } catch {
      continue;
    }
  }
  return 'none';
}

/**
 * Detects the active agent role from the initial prompt lines of the session transcript.
 *
 * Inspects only transcript lines preceding the first `PLANNER_RESPONSE` or `TOOL_RESULT` entry
 * and selects the role whose bootstrap marker appears earliest, defaulting to `'head'`.
 *
 * @param {string} headText - Opening UTF-8 bytes of `transcript.jsonl`.
 *
 * @returns {'head' | 'builder' | 'reviewer' | 'verifier' | 'distiller'} Detected role key.
 */
function detectRoleFromHead(headText) {
  const promptLines = [];
  for (const line of headText.split('\n')) {
    if (/"type"\s*:\s*"(?:PLANNER_RESPONSE|TOOL_RESULT|GENERIC)"/.test(line)) break;
    promptLines.push(line);
  }
  const prompt = promptLines.join('\n');
  const roleMarkers = [
    ['distiller', ['loop-distiller', 'Distiller bootstrap manifest']],
    ['verifier', ['loop-verifier', 'Verifier bootstrap manifest']],
    ['reviewer', ['loop-reviewer', 'Reviewer bootstrap manifest']],
    ['builder', ['loop-builder', 'Builder bootstrap manifest']],
  ];
  let bestRole = 'head';
  let bestIdx = Infinity;
  for (const [role, patterns] of roleMarkers) {
    for (const pat of patterns) {
      const idx = prompt.indexOf(pat);
      if (idx !== -1 && idx < bestIdx) {
        bestIdx = idx;
        bestRole = role;
      }
    }
  }
  return bestRole;
}

/**
 * Inspects `transcriptPath` to determine if an ungrounded compaction `CHECKPOINT` occurred.
 *
 * Detects the session role from the initial prompt and reads expanding tail windows until a
 * qualifying manifest read tool call or `CHECKPOINT` entry is found.
 *
 * @param {string}  transcriptPath - Path to the active session's `transcript.jsonl` file.
 * @param {boolean} isStopHook     - Whether the current invocation is a `Stop` hook event.
 *
 * @returns {{ needed: boolean, role: 'head' | 'builder' | 'reviewer' | 'verifier' | 'distiller' }} Grounding requirement and role.
 */
function checkCompactionGrounding(transcriptPath, isStopHook) {
  const fd = openSync(transcriptPath, 'r');
  try {
    const size = fstatSync(fd).size;
    const role = detectRoleFromHead(readRange(fd, 0, Math.min(size, HEAD_BYTES)));
    for (let tail = TAIL_BYTES; ; tail *= 2) {
      const start = Math.max(0, size - tail);
      const rawSlice = readRange(fd, start, size);
      const firstNewline = start > 0 ? rawSlice.indexOf('\n') : -1;
      if (start > 0 && firstNewline === -1) {
        if (start === 0) return { needed: false, role };
        continue;
      }
      const state = scanCompactionState(start > 0 ? rawSlice.slice(firstNewline + 1) : rawSlice, role, isStopHook);
      if (state === 'grounded') return { needed: false, role };
      if (state === 'ungrounded') return { needed: true, role };
      if (start === 0) return { needed: false, role };
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
 * @param {string}                                                     workspaceRoot - Absolute path to the workspace root directory.
 * @param {'head' | 'builder' | 'reviewer' | 'verifier' | 'distiller'} role          - Active agent role.
 *
 * @returns {string} Complete post-compaction grounding instruction with sentinel prefix.
 */
function loadOrGenerateGroundingNote(workspaceRoot, role) {
  const notePath = resolve(workspaceRoot, '.memory', role === 'head' ? 'post-compaction.md' : `post-compaction-${role}.md`);
  if (existsSync(notePath)) {
    const existing = readFileSync(notePath, 'utf8').trim();
    if (existing.length > 0) return existing.startsWith(GROUNDING_SENTINEL_PREFIX) ? existing : `${GROUNDING_SENTINEL_PREFIX} ${existing}`;
  }
  const files = ROLE_GROUNDING_FILES[role] ?? ROLE_GROUNDING_FILES.head;
  const suffix =
    role === 'head'
      ? " Do not load inactive *_LOOP.md files, docs/CODING_SAMPLE.md, or other roles' rule/lesson files. Do not do anything else before you finish."
      : ' Do not do anything else before you finish.';
  const generated = `${GROUNDING_SENTINEL_PREFIX} You were compacted. Ground yourself immediately: read ${files.join(', ')} in this exact sequence, one by one, each one fully.${suffix}`;
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
  const { needed, role } = checkCompactionGrounding(payload.transcriptPath, isStopHook);
  if (!needed) {
    process.stdout.write(isStopHook ? '{"decision":"allow"}\n' : '{}\n');
    return;
  }
  const workspaceRoot = payload.workspacePaths?.[0] || resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const note = loadOrGenerateGroundingNote(workspaceRoot, role);
  const response = isStopHook ? { decision: 'continue', reason: note } : { injectSteps: [{ systemMessage: { systemMessage: note } }] };
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

try {
  await main();
} catch {
  process.stdout.write('{}\n');
}
