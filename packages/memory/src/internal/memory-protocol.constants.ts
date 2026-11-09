/**
 * Sentinel compaction checkpoint identifier written by `memory_init` so the next file-interaction
 * hook binds to the active transcript epoch without clearing `seenRecordIds`.
 */
export const PENDING_HOOK_EPOCH = 'PENDING_HOOK_EPOCH';

/**
 * Default compaction checkpoint identifier before any compaction boundary occurs in a session.
 */
export const INITIAL_COMPACTION_EPOCH = 'epoch-0';

/**
 * Prefix prepended to `renderedText` when a `read-count` or `soft-expiry` note is drained on its final read.
 */
export const FINAL_READ_DRAINED_PREFIX = '[FINAL READ - DRAINED] ';

/**
 * Synthetic filename segment used when probing glob intersections and directory coverage.
 */
export const PROBE_FILE_SEGMENT = '__probe__';

/**
 * Synthetic subdirectory segment used when expanding `'**'` during glob probe construction.
 */
export const PROBE_SUBDIR_SEGMENT = '__sub__';

/**
 * Default relative probe suffixes always included by `buildRelativeProbes`.
 */
export const DEFAULT_RELATIVE_PROBES: readonly string[] = Object.freeze([
  '__probe__',
  '__sub__/__probe__',
]);

/**
 * Primary workspace-relative path probed when discovering `memory.config.json`.
 */
export const AGENTS_CONFIG_REL_PATH = '.agents/memory.config.json';

/**
 * Fallback workspace-relative path probed when `.agents/memory.config.json` is absent.
 */
export const CLAUDE_CONFIG_REL_PATH = '.claude/memory.config.json';

/**
 * Filename of the monotonic high-water-mark metadata file co-located with `memory.jsonl`.
 */
export const MEMORY_META_FILENAME = 'memory.meta.json';

/**
 * Workspace-relative directory storing per-session compaction epoch states and locks.
 */
export const SESSION_STATE_REL_DIR = '.memory/.session-state';

/**
 * Filename of the fallback active session role state inside `.memory/.session-state/`.
 */
export const LATEST_ROLE_FILENAME = 'latest-role.json';

/**
 * Filename of the advisory lock guarding `.memory/.session-state/latest-role.json`.
 */
export const LATEST_ROLE_LOCK_FILENAME = 'latest-role.lock';

/**
 * Mandatory `.gitignore` entries enforced inside `<checkoutDir>/.gitignore`.
 */
export const MEMORY_GITIGNORE_ENTRIES: readonly string[] = Object.freeze([
  '.session-state/',
  '*.lock',
  '*.tmp*',
]);

/**
 * Glob patterns excluded when falling back to `tinyglobby` outside a Git worktree.
 */
export const TINYGLOBBY_IGNORE_PATTERNS: readonly string[] = Object.freeze([
  '**/.git/**',
  '**/node_modules/**',
  '.memory/.session-state/**',
]);

/**
 * Fallback Git author name used when auto-committing memory ledger changes.
 */
export const FALLBACK_GIT_AUTHOR_NAME = 'paraharness-memory';

/**
 * Fallback Git author email used when auto-committing memory ledger changes.
 */
export const FALLBACK_GIT_AUTHOR_EMAIL = 'memory@paraharness.local';

/**
 * Ordered environment variable names checked when `sessionId` is omitted from tool inputs.
 */
export const SESSION_ID_ENV_VARS: readonly string[] = Object.freeze([
  'CLAUDE_SESSION_ID',
  'AGY_SESSION_ID',
]);

/**
 * Canonical prefixes for rule (`R`), lesson (`L`), and note (`N`) record identifiers.
 */
export const MEMORY_RECORD_PREFIXES: readonly ('R' | 'L' | 'N')[] = Object.freeze([
  'R',
  'L',
  'N',
]);

/**
 * Canonical presentation sort rank by record type (`rule: 0`, `lesson: 1`, `note: 2`).
 */
export const MEMORY_TYPE_RANK: Readonly<Record<'rule' | 'lesson' | 'note', number>> =
  Object.freeze({
    rule: 0,
    lesson: 1,
    note: 2,
  });

/**
 * Maximum number of 3-way reconciliation push retry attempts on concurrent remote divergence.
 */
export const MAX_GIT_PUSH_RETRIES = 3;

/**
 * Default timeout in milliseconds for local and remote `git` subprocess invocations.
 */
export const GIT_COMMAND_TIMEOUT_MS = 30_000;

/**
 * Minimum character length required for both the action and mechanism clauses around `' because '`.
 */
export const MIN_BECAUSE_CLAUSE_CHARS = 10;

/**
 * Mandatory causal connector substring checked by `validateLessonTextFormat`.
 */
export const BECAUSE_SUBSTRING = ' because ';

/**
 * Pre-compiled regular expression matching glob metacharacters and extglob prefixes (§4.2).
 */
export const GLOB_METACHAR_REGEX = /[*?[\]{}!]|[@+*?!]\(/u;

/**
 * Pre-compiled regular expression detecting sentence-splitting punctuation followed by whitespace (§6.7).
 */
export const SENTENCE_SPLIT_PUNCTUATION_REGEX = /[.!?]\s+/u;

/**
 * Pre-compiled regular expression matching Windows drive-letter prefixes (`C:`).
 */
export const WINDOWS_DRIVE_PREFIX_REGEX = /^[A-Za-z]:/u;

/**
 * Pre-compiled regular expression matching normalized Windows drive-letter paths (`C:/`).
 */
export const WINDOWS_DRIVE_SLASH_REGEX = /^[A-Za-z]:\//u;

/**
 * Pre-compiled regular expression matching two or more consecutive forward slashes.
 */
export const CONSECUTIVE_SLASHES_REGEX = /\/+/gu;

/**
 * Pre-compiled regular expression matching one or more leading `./` path prefixes.
 */
export const LEADING_DOT_SLASH_REGEX = /^(\.\/)+/u;

/**
 * Pre-compiled regular expression matching one or more trailing forward slashes.
 */
export const TRAILING_SLASHES_REGEX = /\/+$/u;

/**
 * Pre-compiled regular expression matching one or more leading forward slashes.
 */
export const LEADING_SLASHES_REGEX = /^\/+/u;

/**
 * Pre-compiled regular expression extracting added record IDs from `git log -p -S '"id":"'` output (§3.1).
 */
export const GIT_LOG_ID_MATCH_REGEX = /\+[^\r\n]*"id"\s*:\s*"([RLN])([1-9]\d*)"/gu;

/**
 * Pre-compiled regular expression matching innermost brace expansion groups (`{a,b}`).
 */
export const BRACE_GROUP_REGEX = /\{([^{}]+)\}/u;

/**
 * Process-wide cache of pre-compiled `picomatch` glob matchers keyed by normalized glob pattern (`Rule 4.4`).
 */
export const PICOMATCH_MATCHER_CACHE = new Map<string, (input: string) => boolean>();

/**
 * Process-wide cache of tracked workspace file lists keyed by normalized `workspaceRoot`.
 */
export const REPO_FILES_CACHE = new Map<
  string,
  { readonly treeKey: string; readonly files: readonly string[] }
>();

/**
 * Process-wide cache of pre-compiled forbidden `RegExp` instances keyed by pattern string (`Rule 4.4`).
 */
export const COMPILED_FORBID_REGEX_CACHE = new Map<string, RegExp>();
