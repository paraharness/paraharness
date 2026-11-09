# Unified Memory Harness Specification (`@paraharness/memory`)

## 1. Product Overview, Scope & Core Principles

### 1.1 Problem Statement & Product Goals

Agentic engineering workflows rely on three distinct categories of durable knowledge across sessions and context compactions:
1. **Owner-Mandated Rules (`type: 'rule'`):** Standing constraints declared by the Owner (`rule: <text>`) that bind either all roles (`role: 'general'`) or a specific role.
2. **Empirical Lessons (`type: 'lesson'`):** Atomic, mechanism-grounded operational checks (`"Do <X> when <Y>, because <Z>."`) distilled when a defect or near-miss survives Tier-1 mechanical enforcement (tests, types, linters, scripts) and Tier-2 role/documentation updates.
3. **Operational & Design Notes (`type: 'note'`):** Settled architectural decisions with their rationales and accepted trade-offs, active epic context, and cross-session or cross-role handoffs that previously lived in static markdown files (`peer-notes.md`, `consultant-notes.md`).

Maintaining these three categories in separate static markdown files (`LESSONS.md`, `lessons/<ROLE>.md`, `peer-notes.md`, `skills/lesson/SKILL.md`) and shell scripts (`lesson.sh`) causes four structural failures:
1. **Unfiltered Context Bloat:** Loading an entire role's lessons file on Turn 1 forces every session to pay token costs on every turn for path-specific lessons (`packages/lockfile/**`, `packages/sqlite/**`) even when the session never touches those directories.
2. **Static Skill Drift:** Hardcoding file paths, caps, and CLI flags inside a static `skills/lesson/SKILL.md` breaks whenever a project customizes its roles, storage layout, or lesson format.
3. **Multi-Turn Shell Ping-Pong & Form Bugs:** External shell scripts that parse LLM text with column-indexed `awk` fail on minor formatting drift, require two-turn retry loops to widen an existing lesson, and cannot natively delegate to host subagents.
4. **Compaction & Handoff Loss:** Static notes files lack lifecycle semantics (`persistent`, `read-count`, `hard-expiry`, `soft-expiry`), forcing manual cleanup or losing one-shot handoff notes across context compactions.

The **Unified Memory Harness** replaces static `LESSONS.md`, `lessons/<ROLE>.md`, `peer-notes.md`, `consultant-notes.md`, and `skills/lesson/SKILL.md` with:
- A project configuration file (`.agents/memory.config.json`, falling back to `.claude/memory.config.json`),
- A single atomic JSON Lines ledger (`.memory/memory.jsonl`) paired with monotonic ID high-water marks (`.memory/memory.meta.json`),
- Five Zod-validated tools (`memory_init`, `memory_load_scoped`, `memory_propose`, `memory_commit`, `memory_drain_notes`),
- A configurable Distiller agent pipeline (`runner: 'subagent' | 'claude-cli'`), and
- A Just-In-Time File-Interaction Hook that injects matching path-scoped memories on the first interaction with a matching file or directory within each compaction epoch.

---

### 1.2 Core Architectural Invariants

1. **Single Startup Instruction per Role Skill:** Role skills (`peer/SKILL.md`, `builder`, `reviewer`, `verifier`, `head`) require only a single startup rule: call `memory_init({ role })` at session start and after every context compaction before replying. `memory_init` dynamically generates and returns the project's config-adapted **Memory Protocol** together with all unscoped `general` and `<role>` memories. Static `skills/lesson/SKILL.md` and `peer-notes.md` files are eliminated.
2. **Deterministic Presentation Order (`R*` $\to$ `L*` $\to$ `N*`):** Every read operation (`memory_init`, `memory_load_scoped`, and the file-interaction hook) returns matching records partitioned and ordered strictly by type priority—**Rules (`R1, R2, ...`) first, Lessons (`L1, L2, ...`) second, Active Notes (`N1, N2, ...`) third**—and sorted within each type by ascending numeric ID.
3. **Three-Tier Filter Before Lesson Creation:** Before calling `memory_propose` for `type: 'lesson'`, the caller and the Distiller enforce three tiers in strict order without reciting tier jargon to the Owner:
   - **Tier 1:** Enforce the invariant mechanically with a unit test, a TypeScript type, an ESLint rule, or a build script.
   - **Tier 2:** Fix the vague, missing, or contradictory line in the governing role rule or specification document.
   - **Tier 3:** Record or widen a single-sentence atomic lesson matching `config.format` (`"Do <X> when <Y>, because <Z>."`).
4. **Rule Authority & Protection (`type: 'rule'`):**
   - Rules originate strictly from Owner mandates (`rule: <text>` or explicit Owner instruction).
   - A candidate rule is never written raw: the agent calls `memory_propose({ type: 'rule', ... })`, presents the Distiller's formatted wording and any overlap choice (`update` existing `R<n>` vs `add` new `R<next>`) to the Owner in prose, and calls `memory_commit` **only after** the Owner gives explicit `"go"` confirmation.
   - An existing `type: 'rule'` record may **never** be downgraded to `type: 'lesson'`, may **never** be removed or merged by an autonomous lesson `capMerge`, and is **not** forced into the `"Do <X> when <Y>, because <Z>."` lesson template or stripped of intentional identifiers.
5. **Note Direct Write & Lifecycle Semantics (`type: 'note'`):**
   - Operational notes (`N<n>`) bypass `memory_propose` and the lesson format filter so exact symbol names, ticket IDs, metrics, dates, and accepted trade-offs are preserved verbatim.
   - Every note carries an explicit 4-mode `lifecycle` (`persistent`, `read-count`, `hard-expiry`, `soft-expiry`) evaluated lazily under lock during matching reads.
6. **Human-Safe Cap Pressure (Zero Bogus Merges):**
   - In the `softCap <= count < hardCap` consolidation zone, `memory_propose` instructs the Distiller to offer a `capMerge` of two existing records in the same bucket **if and only if** those two existing records genuinely share the same underlying failure mechanism. If all existing records in the bucket have distinct mechanisms, `capMerge` MUST be omitted (`undefined`) so a tired human or agent is never tempted to rubber-stamp a degrading merge of unrelated lessons.

---

## 2. Configuration Discovery & Schema (`memory.config.json`)

### 2.1 Discovery Resolution Contract

When any Unified Memory tool or hook executes against a `workspaceRoot` directory:
1. If an explicit `configPath` override is supplied in `MemoryHarnessOptions`, resolve `path.resolve(workspaceRoot, configPath)`.
2. Otherwise, check `<workspaceRoot>/.agents/memory.config.json` first.
3. If `<workspaceRoot>/.agents/memory.config.json` does not exist, check `<workspaceRoot>/.claude/memory.config.json` second.
4. If neither file exists, throw `MemoryHarnessError` with code `'CONFIG_NOT_FOUND'` listing both probed paths.
5. Parse the file as UTF-8 JSON and validate it against `MemoryConfigSchema`. Compile every pattern in `format.forbidRegexes` via `new RegExp(pattern, 'u')` at config load time; if JSON parsing or Zod/RegExp validation fails, throw `MemoryHarnessError` with code `'CONFIG_VALIDATION_FAILED'`.

---

### 2.2 Configuration Zod Schema (`memory-config.schema.ts`)

```ts
import { z } from 'zod';

/**
 * Discriminator for the three record kinds stored in the unified memory ledger.
 */
export const MemoryRecordTypeSchema = z.enum(['rule', 'lesson', 'note']);

/**
 * Inferred union type for memory record kinds (`'rule' | 'lesson' | 'note'`).
 */
export type MemoryRecordType = z.infer<typeof MemoryRecordTypeSchema>;

/**
 * Git synchronization configuration for `.memory` branch worktrees or external shared repositories.
 */
export const MemoryGitStorageConfigSchema = z.object({
  enabled: z.boolean().default(false),
  checkoutDir: z.string().min(1).default('.memory'),
  remoteUrl: z.string().min(1).optional(),
  branch: z.string().min(1).default('main'),
  autoCommit: z.boolean().default(true),
  autoPush: z.boolean().default(false),
});

/**
 * Inferred Git storage configuration type.
 */
export type MemoryGitStorageConfig = z.infer<typeof MemoryGitStorageConfigSchema>;

/**
 * Ledger file path and optional Git synchronization settings.
 */
export const MemoryStorageConfigSchema = z.object({
  ledgerPath: z.string().min(1).default('.memory/memory.jsonl'),
  git: MemoryGitStorageConfigSchema.default({
    enabled: false,
    checkoutDir: '.memory',
    branch: 'main',
    autoCommit: true,
    autoPush: false,
  }),
});

/**
 * Inferred storage configuration type.
 */
export type MemoryStorageConfig = z.infer<typeof MemoryStorageConfigSchema>;

/**
 * Scoped or unscoped capacity rule governing soft consolidation pressure and hard rejection walls.
 *
 * @note
 * - `paths: []` (empty array) matches exclusively unscoped records (`context === undefined`).
 * - `paths: ['*']` matches any path-scoped record as a fallback per distinct context scope.
 * - Specific globs/paths in `paths` (such as `['packages/bar/**']`) define a dedicated budget for that scope.
 * - `roles: ['general']` matches only `record.role === 'general'`; `roles: ['*']` partitions into a separate per-role bucket for each role.
 * - `types` defaults to `['lesson']` when omitted so rules and notes are uncapped unless explicitly listed.
 */
export const MemoryCapRuleSchema = z
  .object({
    softCap: z.number().int().min(1),
    hardCap: z.number().int().min(1),
    roles: z.array(z.string().min(1)).min(1).default(['*']),
    paths: z.array(z.string().min(1)).default(['*']),
    types: z.array(MemoryRecordTypeSchema).min(1).default(['lesson']),
  })
  .refine((rule) => rule.hardCap >= rule.softCap, {
    message: 'hardCap must be greater than or equal to softCap.',
    path: ['hardCap'],
  });

/**
 * Inferred capacity rule configuration type.
 */
export type MemoryCapRule = z.infer<typeof MemoryCapRuleSchema>;

/**
 * Deterministic formatting constraints enforced exclusively on `type: 'lesson'` records.
 */
export const MemoryLessonFormatConfigSchema = z.object({
  maxChars: z.number().int().min(50).max(2000).default(500),
  template: z.string().min(1).default('Do <X> when <Y>, because <Z>.'),
  requireSubstrings: z.array(z.string().min(1)).default([' because ']),
  requireSingleSentence: z.boolean().default(true),
  forbidRegexes: z
    .array(z.string().min(1))
    .default([
      '\\b\\d{4}-\\d{2}-\\d{2}\\b',
      '\\b(?:TIC|CD|INC|PR|ISS)-\\d+\\b',
      '#\\d+\\b',
      '["“”„«»]',
    ]),
});

/**
 * Inferred lesson formatting configuration type.
 */
export type MemoryLessonFormatConfig = z.infer<typeof MemoryLessonFormatConfigSchema>;

/**
 * Execution runner and model configuration for the Distiller agent invoked by `memory_propose`.
 */
export const MemoryDistillerConfigSchema = z.object({
  runner: z.enum(['subagent', 'claude-cli']).default('subagent'),
  model: z.string().min(1).default('opus'),
  effort: z.enum(['low', 'medium', 'high']).default('high'),
  timeoutMs: z.number().int().min(1000).max(600000).default(120000),
  customInstructions: z.string().min(1).optional(),
});

/**
 * Inferred Distiller configuration type.
 */
export type MemoryDistillerConfig = z.infer<typeof MemoryDistillerConfigSchema>;

/**
 * Root configuration schema for `.agents/memory.config.json` (fallback `.claude/memory.config.json`).
 */
export const MemoryConfigSchema = z
  .object({
    repoId: z.string().min(1),
    storage: MemoryStorageConfigSchema.default({
      ledgerPath: '.memory/memory.jsonl',
      git: {
        enabled: false,
        checkoutDir: '.memory',
        branch: 'main',
        autoCommit: true,
        autoPush: false,
      },
    }),
    allowedRoles: z
      .array(z.string().min(1))
      .min(1)
      .refine((roles) => roles.includes('general'), {
        message: 'allowedRoles must include "general".',
      }),
    maxTotalRecords: z.number().int().min(1).optional(),
    caps: z.array(MemoryCapRuleSchema).default([
      {
        roles: ['general'],
        paths: [],
        types: ['lesson'],
        softCap: 15,
        hardCap: 25,
      },
      {
        roles: ['*'],
        paths: [],
        types: ['lesson'],
        softCap: 15,
        hardCap: 25,
      },
      {
        roles: ['*'],
        paths: ['*'],
        types: ['lesson'],
        softCap: 10,
        hardCap: 20,
      },
    ]),
    format: MemoryLessonFormatConfigSchema.default({
      maxChars: 500,
      template: 'Do <X> when <Y>, because <Z>.',
      requireSubstrings: [' because '],
      requireSingleSentence: true,
      forbidRegexes: [
        '\\b\\d{4}-\\d{2}-\\d{2}\\b',
        '\\b(?:TIC|CD|INC|PR|ISS)-\\d+\\b',
        '#\\d+\\b',
        '["“”„«»]',
      ],
    }),
    distiller: MemoryDistillerConfigSchema.default({
      runner: 'subagent',
      model: 'opus',
      effort: 'high',
      timeoutMs: 120000,
    }),
  })
  .superRefine((cfg, ctx) => {
    const allowedSet = new Set(cfg.allowedRoles);
    for (let i = 0; i < cfg.caps.length; i += 1) {
      const cap = cfg.caps[i];
      if (cap === undefined) continue;
      for (const r of cap.roles) {
        if (r !== '*' && !allowedSet.has(r)) {
          ctx.addIssue({
            code: 'custom',
            path: ['caps', i, 'roles'],
            message: `Cap role '${r}' is not present in allowedRoles.`,
          });
        }
      }
    }
    for (let i = 0; i < cfg.format.forbidRegexes.length; i += 1) {
      const pattern = cfg.format.forbidRegexes[i];
      if (pattern === undefined) continue;
      try {
        new RegExp(pattern, 'u');
      } catch {
        ctx.addIssue({
          code: 'custom',
          path: ['format', 'forbidRegexes', i],
          message: `Invalid regular expression pattern '${pattern}'.`,
        });
      }
    }
  });

/**
 * Inferred root configuration type for the Unified Memory Harness.
 */
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
```

---

## 3. Ledger Record Schema, Monotonic IDs & Note Lifecycles (`memory.jsonl`)

### 3.1 Ledger & Metadata Files

1. **Ledger File (`<ledgerPath>`, default `.memory/memory.jsonl`):**
   - UTF-8 encoded JSON Lines file where each line is a single serialized `MemoryRecord` JSON object followed by `\n`.
   - If `<ledgerPath>` does not exist on disk during a read operation, the ledger is treated as empty (`[]`); during the first mutating operation, its parent directory, `<ledgerPath>`, and `<ledgerDir>/memory.meta.json` are created atomically.
   - On every write, records in `memory.jsonl` are written in canonical deterministic order: sorted first by `typeRank` (`rule: 0`, `lesson: 1`, `note: 2`), and second by ascending numeric suffix of `id` (`Number(id.slice(1))`).
2. **Monotonic High-Water-Mark Metadata File (`<ledgerDir>/memory.meta.json`):**
   - Co-located in the same directory as `memory.jsonl` and protected by the same exclusive file lock (`<ledgerPath>.lock`).
   - Stores the highest numeric ID ever allocated for each prefix (`R`, `L`, `N`) so deleted or lazily drained IDs are **never reused**:
     ```ts
     /**
      * Persistent monotonic ID high-water-mark metadata stored alongside `memory.jsonl`.
      */
     export const MemoryMetaSchema = z.object({
       schemaVersion: z.literal(1),
       highWaterMarks: z.object({
         R: z.number().int().min(0),
         L: z.number().int().min(0),
         N: z.number().int().min(0),
       }),
     });

     /**
      * Inferred monotonic ID high-water-mark metadata type.
      */
     export type MemoryMeta = z.infer<typeof MemoryMetaSchema>;
     ```
   - **Self-Healing Allocation Rule:** Before allocating a new ID for prefix `P` (`'R' | 'L' | 'N'`), compute `effectiveMax = Math.max(meta.highWaterMarks[P], maxNumericIdInLedger(records, P))`, allocate `${P}${effectiveMax + 1}`, and set `meta.highWaterMarks[P] = effectiveMax + 1`. If `memory.meta.json` does not exist yet on first run, initialize it from `maxNumericIdInLedger` across current `memory.jsonl` records (and `git log -p -S '"id":"' -- <ledgerPath>` if inside a Git checkout with prior history).

---

### 3.2 Note Lifecycle & Record Zod Schemas (`memory-record.schema.ts`)

```ts
import { z } from 'zod';

/**
 * Lifecycle mode names supported on `type: 'note'` records.
 */
export const NoteLifecycleModeSchema = z.enum([
  'persistent',
  'read-count',
  'hard-expiry',
  'soft-expiry',
]);

/**
 * Inferred note lifecycle mode union type.
 */
export type NoteLifecycleMode = z.infer<typeof NoteLifecycleModeSchema>;

/**
 * Four-variant discriminated union governing when a `type: 'note'` record is lazily drained.
 */
export const NoteLifecycleSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('persistent'),
  }),
  z.object({
    mode: z.literal('read-count'),
    remainingReads: z.number().int().min(1),
  }),
  z.object({
    mode: z.literal('hard-expiry'),
    expiresAt: z.iso.datetime(),
  }),
  z.object({
    mode: z.literal('soft-expiry'),
    expiresAt: z.iso.datetime(),
  }),
]);

/**
 * Inferred note lifecycle union type.
 */
export type NoteLifecycle = z.infer<typeof NoteLifecycleSchema>;

/**
 * Shared base fields present on every record in `memory.jsonl`.
 */
const MemoryRecordBaseFields = {
  role: z.string().min(1),
  text: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime().optional(),
  context: z.array(z.string().min(1)).min(1).optional(),
  repos: z.array(z.string().min(1)).min(1).optional(),
};

/**
 * Owner-mandated rule record (`R1, R2, ...`).
 */
export const MemoryRuleRecordSchema = z.object({
  id: z.string().regex(/^R[1-9]\d*$/),
  type: z.literal('rule'),
  ...MemoryRecordBaseFields,
});

/**
 * Inferred rule record type.
 */
export type MemoryRuleRecord = z.infer<typeof MemoryRuleRecordSchema>;

/**
 * Agent-distilled empirical lesson record (`L1, L2, ...`).
 */
export const MemoryLessonRecordSchema = z.object({
  id: z.string().regex(/^L[1-9]\d*$/),
  type: z.literal('lesson'),
  ...MemoryRecordBaseFields,
});

/**
 * Inferred lesson record type.
 */
export type MemoryLessonRecord = z.infer<typeof MemoryLessonRecordSchema>;

/**
 * Operational or design decision note record (`N1, N2, ...`) with mandatory lifecycle.
 */
export const MemoryNoteRecordSchema = z.object({
  id: z.string().regex(/^N[1-9]\d*$/),
  type: z.literal('note'),
  ...MemoryRecordBaseFields,
  lifecycle: NoteLifecycleSchema,
});

/**
 * Inferred note record type.
 */
export type MemoryNoteRecord = z.infer<typeof MemoryNoteRecordSchema>;

/**
 * Discriminated union of all records stored in `memory.jsonl`.
 */
export const MemoryRecordSchema = z.discriminatedUnion('type', [
  MemoryRuleRecordSchema,
  MemoryLessonRecordSchema,
  MemoryNoteRecordSchema,
]);

/**
 * Inferred memory record union type.
 */
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;
```

---

### 3.3 Note Lifecycle State Machine & Lazy Drainage Contract

Let `nowMs = Date.now()` (UTC epoch milliseconds) at the moment a read or write operation inspects `memory.jsonl` under the exclusive file lock:

| Lifecycle Mode | Condition When Note Is Matched by a Read Operation (`memory_init`, `memory_load_scoped`, or File Hook) | Returned to Caller on This Read? | Ledger Mutation Applied Under Lock |
| :--- | :--- | :---: | :--- |
| **`persistent`** | Always | **Yes** (`drainedOnThisRead: false`) | None (remains in `memory.jsonl` until removed via `memory_commit({ op: 'remove' })` or `memory_drain_notes`). |
| **`read-count`** | `remainingReads > 1` | **Yes** (`drainedOnThisRead: false`) | Decrement `remainingReads` to `remainingReads - 1` and persist `memory.jsonl`. |
| **`read-count`** | `remainingReads === 1` | **Yes** (`drainedOnThisRead: true`, prefixed `[FINAL READ - DRAINED]`) | Delete record from `memory.jsonl` and persist. |
| **`hard-expiry`** | `nowMs < Date.parse(expiresAt)` | **Yes** (`drainedOnThisRead: false`) | None. |
| **`hard-expiry`** | `nowMs >= Date.parse(expiresAt)` | **No** (omitted from response) | Delete record from `memory.jsonl` and persist (also purged opportunistically on any ledger write or read). |
| **`soft-expiry`** | `nowMs < Date.parse(expiresAt)` | **Yes** (`drainedOnThisRead: false`) | None. |
| **`soft-expiry`** | `nowMs >= Date.parse(expiresAt)` | **Yes** (`drainedOnThisRead: true`, prefixed `[FINAL READ - DRAINED]`) | Delete record from `memory.jsonl` and persist immediately after constructing the read response. |

**Scoping & Compaction Drainage Invariants:**
1. **Unscoped vs. Scoped Isolation:** `memory_init` selects only **unscoped** records (`context === undefined`). Therefore, `memory_init` MUST NOT decrement `remainingReads` or trigger `soft-expiry` final-read drainage on any **path-scoped** note (`context !== undefined`). Path-scoped notes are evaluated for `read-count` and `soft-expiry` transitions exclusively when matched and returned by `memory_load_scoped` or injected by the File-Interaction Hook.
2. **Hook Deduplication Protection:** When the File-Interaction Hook suppresses a scoped note because its `id` is already in `seenRecordIds` for the current compaction epoch, that suppressed touch is **not** a read and MUST NOT decrement `remainingReads` or trigger `soft-expiry` drainage.

---

## 4. Path Normalization & 4-Way Context Matching Contract

### 4.1 Path & Glob Normalization (`normalizeMemoryPathPattern`)

Every path or glob string passed in `record.context`, `memory_load_scoped.paths`, `memory_propose.context`, `memory_commit.context`, `memory_drain_notes.paths`, `config.caps[*].paths`, or extracted by the File-Interaction Hook MUST be normalized via `normalizeMemoryPathPattern(rawPath, workspaceRoot)` before storage or comparison:

1. Trim leading and trailing whitespace; if empty, throw `MemoryHarnessError` (`'VALIDATION_FAILED'`).
2. Replace all Windows path separators `\` with POSIX `/`.
3. If the string is an absolute path inside `workspaceRoot` (`normalized.startsWith(workspaceRootPosix + '/')`), strip the `workspaceRootPosix + '/'` prefix so it becomes workspace-relative.
4. Strip any leading `./` segments and any leading `/`.
5. Collapse consecutive slashes `//` into a single `/`.
6. Strip any trailing `/` (so `'packages/lockfile/'` normalizes to `'packages/lockfile'`).
7. Split on `/` and reject any pattern containing a `'..'` segment or interior `'.'` segment with `MemoryHarnessError` (`'VALIDATION_FAILED'`) so patterns cannot escape the repository root.
8. If the resulting string is empty (for example, raw input was `'/'` or `'.'`), normalize it to `'**/*'`.

---

### 4.2 Pattern Classification & Static Prefix Extraction

1. **`isGlobPattern(normalized: string): boolean`:**
   Returns `true` if and only if `normalized` contains any unescaped glob metacharacter from the set `*`, `?`, `[`, `]`, `{`, `}`, `!`, or extglob prefixes `@(`, `+(`, `*(`, `?(`, `!( )`. Otherwise, `normalized` is classified as a **`specific`** path (identifying a specific file or directory path).
2. **`extractStaticDirPrefix(globPattern: string): string`:**
   Splits `globPattern` on `/`, collects all leading path segments that contain zero glob metacharacters, and joins them with `/` (returning `''` when the first segment contains a glob metacharacter, such as `'**/*.sql'`).

---

### 4.3 Four-Way Symmetric Matching (`matchesContextScope`)

Given normalized query items `Q = readonly string[]`, normalized record context items `C = readonly string[]`, and the repository's tracked relative file list `repoFiles = readonly string[]` (obtained via `git ls-files` cached per workspace tree state, falling back to `tinyglobby` when outside a Git worktree), `matchesContextScope(Q, C, repoFiles)` returns `true` if and only if there exists at least one `q` in `Q` and at least one `c` in `C` such that `matchSingleContextPair(q, c, repoFiles)` evaluates to `true` under one of the four exhaustive cases:

1. **Case 1 — Specific-to-Specific (`!isGlobPattern(q) && !isGlobPattern(c)`):**
   Returns `true` if and only if:
   - `q === c` (exact file or directory match), or
   - `q.startsWith(c + '/')` (`q` is a file or subdirectory inside directory `c`), or
   - `c.startsWith(q + '/')` (`c` is a file or subdirectory inside directory `q`).

2. **Case 2 — Specific-to-Pattern (`!isGlobPattern(q) && isGlobPattern(c)`):**
   Let `cPrefix = extractStaticDirPrefix(c)` and `cMatcher = picomatch(c, { dot: true })` (pre-compiled per `CODING_GUIDELINES.md` Rule 4.4). Returns `true` if and only if at least one holds:
   - `cMatcher(q)` is `true` (for example, `q = 'packages/lockfile/src/index.ts'` matches `c = 'packages/lockfile/**/*'`), or
   - `cMatcher(q + '/__probe__')` is `true` (for example, `q = 'packages/lockfile'` matches `c = 'packages/lockfile/**'` or `c = 'packages/lockfile/**/*'`), or
   - `cPrefix.length > 0 && (cPrefix === q || cPrefix.startsWith(q + '/'))` (for example, `q = 'packages'` or `q = 'packages/lockfile'` contains the pattern's static directory prefix `c = 'packages/lockfile/src/*.ts'`), or
   - There exists a file `f` in `repoFiles` such that `(f === q || f.startsWith(q + '/')) && cMatcher(f)` (for example, directory `q = 'packages/lockfile'` contains tracked file `'packages/lockfile/schema.sql'` matching `c = '**/*.sql'`).

3. **Case 3 — Pattern-to-Specific (`isGlobPattern(q) && !isGlobPattern(c)`):**
   Symmetric to Case 2 (`matchSingleContextPair(c, q, repoFiles)`):
   Let `qPrefix = extractStaticDirPrefix(q)` and `qMatcher = picomatch(q, { dot: true })`. Returns `true` if and only if at least one holds:
   - `qMatcher(c)` is `true`, or
   - `qMatcher(c + '/__probe__')` is `true`, or
   - `qPrefix.length > 0 && (qPrefix === c || qPrefix.startsWith(c + '/'))`, or
   - There exists a file `f` in `repoFiles` such that `(f === c || f.startsWith(c + '/')) && qMatcher(f)`.

4. **Case 4 — Pattern-to-Pattern (`isGlobPattern(q) && isGlobPattern(c)`):**
   Let `qMatcher = picomatch(q, { dot: true })`, `cMatcher = picomatch(c, { dot: true })`, `qPrefix = extractStaticDirPrefix(q)`, and `cPrefix = extractStaticDirPrefix(c)`. Returns `true` if and only if at least one holds:
   - `q === c`, or
   - `qMatcher(c) || cMatcher(q)`, or
   - There exists a file `f` in `repoFiles` such that `qMatcher(f) && cMatcher(f)`, or
   - When `repoFiles` contains no files matching either `qPrefix` or `cPrefix` (such as an unpopulated directory during initial scaffolding), `(qPrefix === '' || cPrefix === '' || qPrefix === cPrefix || qPrefix.startsWith(cPrefix + '/') || cPrefix.startsWith(qPrefix + '/'))` AND their fixed terminal file extensions (if both patterns end in `*.<ext>`) are identical.

---

## 5. Capacity Bucket Resolution & Enforcement Semantics (`config.caps`)

### 5.1 Active Repository Scope Filter

Only records in `memory.jsonl` that apply to the current repository (`record.repos === undefined || record.repos.includes(config.repoId)`) are counted toward `config.maxTotalRecords` and `config.caps`.

---

### 5.2 Most-Specific Bucket Wins Algorithm

Each record `r` counts toward **at most one** capacity bucket in `config.caps`:

1. **Eligibility Filter (`isCapRuleEligibleForRecord(capRule, r, repoFiles)`):**
   A `capRule` at index `i` in `config.caps` is eligible for record `r` if and only if all three conditions hold:
   - **Type eligibility:** `capRule.types.includes(r.type)`.
   - **Role eligibility:** `capRule.roles.includes(r.role) || capRule.roles.includes('*')`.
     - Note: `'general'` in `capRule.roles` matches **only** `r.role === 'general'`; `'*'` matches any role.
   - **Path eligibility:**
     - If `r.context === undefined` (unscoped record): eligible if and only if `capRule.paths.length === 0`.
     - If `r.context !== undefined` (scoped record): eligible if and only if `capRule.paths.length > 0` and `(capRule.paths.includes('*') || matchesContextScope(normalizedCapRulePaths, r.context, repoFiles))`.

2. **Specificity Tuple & Winning Rule Selection:**
   If zero rules in `config.caps` are eligible for `r`, then `r` is uncapped (subject only to `config.maxTotalRecords` if set).
   If one or more rules are eligible, rank each eligible `capRule` at index `i` by the 4-tuple `(pathSpec, roleSpec, typeSpec, -i)` in descending lexicographical order and select the unique maximum:
   - `pathSpec`:
     - `2` if `(r.context === undefined && capRule.paths.length === 0)` OR `(r.context !== undefined && !capRule.paths.includes('*'))` (exact unscoped rule or explicit path/glob rule).
     - `1` if `r.context !== undefined && capRule.paths.includes('*')` (wildcard scoped fallback).
   - `roleSpec`:
     - `2` if `capRule.roles.includes(r.role)` (explicit role match, e.g. `['builder']` or `['general']`).
     - `1` if matched only via `capRule.roles.includes('*')`.
   - `typeSpec`:
     - `2` if `capRule.types.length === 1`.
     - `1` if `capRule.types.length > 1`.
   - `-i`: Earlier array index `i` in `config.caps` wins ties.

3. **Partition Key (`bucketId`) Within the Winning Rule `capRule[winIdx]`:**
   To ensure wildcard rules (`roles: ['*']` or `paths: ['*']`) give each role and each path scope its own independent budget rather than pooling unrelated roles or packages together, the bucket partition key for record `r` under winning rule `winIdx` is:
   - `rolePartition = capRule.roles.includes(r.role) ? capRule.roles.slice().sort().join(',') : 'role:' + r.role`
   - `pathPartition`:
     - If `r.context === undefined`: `'unscoped'`
     - Else if `!capRule.paths.includes('*')`: `'rule-paths:' + normalizedCapRulePaths.slice().sort().join('|')`
     - Else (`capRule.paths.includes('*')`): `'record-context:' + r.context.slice().sort().join('|')`
   - `bucketId = "rule#${winIdx}|role=${rolePartition}|path=${pathPartition}"`
   - All active records in `memory.jsonl` (for `config.repoId`) whose winning rule and `bucketId` match `r`'s `bucketId` form `r`'s bucket population `B`.

---

### 5.3 Three-Zone Capacity Enforcement (`softCap`, `hardCap`, `maxTotalRecords`)

Let `count = B.length` be the number of existing records in the candidate's target bucket `B`, and `totalCount` be the total active records for `config.repoId`:

| Zone | Condition | `memory_propose` Behavior | `memory_commit({ op: 'add' })` Behavior |
| :--- | :--- | :--- | :--- |
| **Zone 1: Under Soft Cap** | `count < softCap` and `(maxTotalRecords === undefined \|\| totalCount < maxTotalRecords)` | Recommends `op: 'update'` if and only if the candidate shares the same mechanism/rule topic as an existing record; otherwise recommends `op: 'add'` with `capMerge: undefined`. | **Permitted** without `capMerge`. |
| **Zone 2: Soft Cap Consolidation Pressure** | `softCap <= count < hardCap` and `(maxTotalRecords === undefined \|\| totalCount < maxTotalRecords)` | Instructs the Distiller that bucket `B` is over `softCap` (`count / softCap`). If the candidate is a new mechanism, the Distiller scans `B` for two existing records of the same `type` that **genuinely share the same underlying mechanism**. If found, attaches `capMerge: { keepId, removeId, mergedText, whyMerged }` to the `op: 'add'` choice. **If no pair in `B` shares a mechanism, `capMerge` MUST be `undefined`.** | **Permitted** both with `capMerge` (keeping net count at `count`) and without `capMerge` (incrementing count to `count + 1 <= hardCap`). |
| **Zone 3: At Hard Cap** | `count >= hardCap` or `(maxTotalRecords !== undefined && totalCount >= maxTotalRecords)` | Sets `bucketStatus.zone = 'AT_HARD_CAP'` (or `maxTotalRecordsReached = true`). Any `op: 'add'` choice requires either `capMerge` (when two existing records of the same `type` in `B` share a mechanism) or the caller must choose `op: 'update'` / remove an obsolete record first. | **Rejected** with `MemoryHarnessError` (`'CAP_EXCEEDED'`) unless `op: 'add'` includes a valid `capMerge` whose `keepId` and `removeId` belong to bucket `B` and have the same `type` as the added record (keeping net bucket count `<= hardCap` and `totalCount <= maxTotalRecords`). |

---

## 6. Tool Contracts & Zod Schemas (`memory-tools.schema.ts`)

### 6.1 Shared Output Record Projections & Error Codes

```ts
import { z } from 'zod';
import {
  MemoryLessonRecordSchema,
  MemoryNoteRecordSchema,
  MemoryRecordSchema,
  MemoryRecordTypeSchema,
  MemoryRuleRecordSchema,
  NoteLifecycleModeSchema,
  NoteLifecycleSchema,
} from './memory-record.schema.js';

/**
 * Deterministic machine-readable error codes thrown by `MemoryHarnessError`.
 */
export const MemoryErrorCodeSchema = z.enum([
  'CONFIG_NOT_FOUND',
  'CONFIG_VALIDATION_FAILED',
  'INVALID_ROLE',
  'VALIDATION_FAILED',
  'LESSON_FORMAT_INVALID',
  'CAP_EXCEEDED',
  'RECORD_NOT_FOUND',
  'RULE_PROTECTION_VIOLATION',
  'DISTILLER_EXECUTION_FAILED',
  'GIT_SYNC_FAILED',
]);

/**
 * Inferred error code union type.
 */
export type MemoryErrorCode = z.infer<typeof MemoryErrorCodeSchema>;

/**
 * Note record returned by read tools, augmented with whether the read triggered final drainage.
 */
export const MemoryLoadedNoteRecordSchema = MemoryNoteRecordSchema.extend({
  drainedOnThisRead: z.boolean(),
  renderedText: z.string().min(1),
});

/**
 * Inferred loaded note record type.
 */
export type MemoryLoadedNoteRecord = z.infer<typeof MemoryLoadedNoteRecordSchema>;

/**
 * Capacity status of the target bucket evaluated during `memory_propose` and `memory_commit`.
 */
export const MemoryBucketStatusSchema = z.object({
  bucketId: z.string().min(1),
  currentCount: z.number().int().min(0),
  softCap: z.number().int().min(1).nullable(),
  hardCap: z.number().int().min(1).nullable(),
  zone: z.enum(['UNCAPPED', 'UNDER_SOFT_CAP', 'SOFT_CAP_PRESSURE', 'AT_HARD_CAP']),
  totalRecordsCount: z.number().int().min(0),
  maxTotalRecords: z.number().int().min(1).nullable(),
  maxTotalRecordsReached: z.boolean(),
});

/**
 * Inferred capacity bucket status type.
 */
export type MemoryBucketStatus = z.infer<typeof MemoryBucketStatusSchema>;
```

---

### 6.2 Tool 1: `memory_init`

Called at session start and after every context compaction by every role.

```ts
/**
 * Input schema for `memory_init`.
 */
export const MemoryInitInputSchema = z.object({
  role: z.string().min(1),
  sessionId: z.string().min(1).optional(),
});

/**
 * Inferred input type for `memory_init`.
 */
export type MemoryInitInput = z.infer<typeof MemoryInitInputSchema>;

/**
 * Output schema for `memory_init`.
 */
export const MemoryInitOutputSchema = z.object({
  role: z.string().min(1),
  repoId: z.string().min(1),
  protocol: z.string().min(1),
  rules: z.array(MemoryRuleRecordSchema),
  lessons: z.array(MemoryLessonRecordSchema),
  notes: z.array(MemoryLoadedNoteRecordSchema),
});

/**
 * Inferred output type for `memory_init`.
 */
export type MemoryInitOutput = z.infer<typeof MemoryInitOutputSchema>;
```

**Behavioral Contract for `memory_init`:**
1. Validate `config.allowedRoles.includes(input.role)`. If invalid, throw `MemoryHarnessError` with code `'INVALID_ROLE'` and details containing `allowedRoles: config.allowedRoles`.
2. Ensure the Git storage checkout (if `config.storage.git.enabled`) is initialized per §8.2.
3. Persist the active session role in `.memory/.session-state/latest-role.json` (and `.memory/.session-state/<sessionId>.json` when `sessionId` is provided or resolved from `CLAUDE_SESSION_ID` / `AGY_SESSION_ID`) so the File-Interaction Hook (§7.2) knows the caller's role even when the hook payload omits it.
4. Acquire the exclusive lock on `<ledgerPath>.lock`:
   - Parse `memory.jsonl` and `memory.meta.json`.
   - Delete any `type: 'note'` record with `lifecycle.mode === 'hard-expiry'` where `nowMs >= Date.parse(lifecycle.expiresAt)`.
   - Select all **unscoped** records (`record.context === undefined`) where `(record.role === 'general' || record.role === input.role)` and `(record.repos === undefined || record.repos.includes(config.repoId))`.
   - Apply the §3.3 lifecycle transition table to each selected unscoped `type: 'note'` record (`read-count` decrement/drainage and `soft-expiry` final-read drainage). When `drainedOnThisRead === true`, set `renderedText = "[FINAL READ - DRAINED] " + note.text`; otherwise `renderedText = note.text`.
   - If any record was mutated or deleted by expiry/drainage, atomically write `memory.jsonl` (and commit/push per §8.2 if `config.storage.git.enabled && config.storage.git.autoCommit`).
5. Generate the config-adapted `protocol` markdown string containing:
   - The 3-tier lesson gate (Tier 1 test/type/linter/script $\to$ Tier 2 role/doc line $\to$ Tier 3 atomic lesson),
   - The project's exact `config.format` rules (`template`, `maxChars`, `requireSubstrings`, `forbidRegexes`) for lessons,
   - The `rule: <text>` workflow (`memory_propose` $\to$ show Owner for `"go"` $\to$ `memory_commit`),
   - The `note` lifecycle modes (`persistent`, `read-count`, `hard-expiry`, `soft-expiry`) and `memory_drain_notes` dry-run-first workflow, and
   - When to call `memory_load_scoped({ role, paths })`.
6. Return `{ role: input.role, repoId: config.repoId, protocol, rules, lessons, notes }` sorted by numeric ID within each array.

---

### 6.3 Tool 2: `memory_load_scoped`

Called when planning or working on specific files, directories, or glob patterns (and invoked internally by the File-Interaction Hook).

```ts
/**
 * Input schema for `memory_load_scoped`.
 */
export const MemoryLoadScopedInputSchema = z.object({
  role: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1),
  sessionId: z.string().min(1).optional(),
});

/**
 * Inferred input type for `memory_load_scoped`.
 */
export type MemoryLoadScopedInput = z.infer<typeof MemoryLoadScopedInputSchema>;

/**
 * Output schema for `memory_load_scoped`.
 */
export const MemoryLoadScopedOutputSchema = z.object({
  role: z.string().min(1),
  normalizedPaths: z.array(z.string().min(1)).min(1),
  rules: z.array(MemoryRuleRecordSchema),
  lessons: z.array(MemoryLessonRecordSchema),
  notes: z.array(MemoryLoadedNoteRecordSchema),
});

/**
 * Inferred output type for `memory_load_scoped`.
 */
export type MemoryLoadScopedOutput = z.infer<typeof MemoryLoadScopedOutputSchema>;
```

**Behavioral Contract for `memory_load_scoped`:**
1. Validate `config.allowedRoles.includes(input.role)` (throwing `MemoryHarnessError` with `'INVALID_ROLE'` and `config.allowedRoles` if invalid).
2. Normalize every element of `input.paths` via `normalizeMemoryPathPattern` (§4.1).
3. Acquire `<ledgerPath>.lock`:
   - Parse `memory.jsonl`, purge expired `hard-expiry` notes (`nowMs >= Date.parse(expiresAt)`), and select all **scoped** records (`record.context !== undefined && record.context.length > 0`) where:
     - `(record.role === 'general' || record.role === input.role)`,
     - `(record.repos === undefined || record.repos.includes(config.repoId))`, and
     - `matchesContextScope(normalizedPaths, record.context, repoFiles)` (§4.3) is `true`.
   - Apply §3.3 lifecycle transitions (`read-count` and `soft-expiry`) to the matched scoped `N*` notes and persist `memory.jsonl` if any note was decremented or drained.
   - If `input.sessionId` is provided (or resolved from environment), record all returned `R*`, `L*`, and `N*` IDs in `.memory/.session-state/<sessionId>.json` for the current compaction epoch (§7.2) so subsequent file touches in the same epoch do not re-inject them.
4. Return `{ role: input.role, normalizedPaths, rules, lessons, notes }` (never re-returning unscoped memories).

---

### 6.4 Tool 3: `memory_propose`

Runs (or prepares) the Distiller agent to format, deduplicate, and check capacity for a candidate `'rule'` or `'lesson'`.

```ts
/**
 * Consolidation merge payload attached to an `op: 'add'` choice when two existing records of the
 * same type in a bucket at or above `softCap` genuinely share the same underlying mechanism.
 */
export const MemoryCapMergeProposalSchema = z.object({
  keepId: z.string().regex(/^[RLN][1-9]\d*$/),
  removeId: z.string().regex(/^[RLN][1-9]\d*$/),
  mergedText: z.string().min(1),
  whyMerged: z.string().min(1),
});

/**
 * Inferred capacity-merge proposal type.
 */
export type MemoryCapMergeProposal = z.infer<typeof MemoryCapMergeProposalSchema>;

/**
 * Choice item produced directly by the Distiller LLM (referencing `targetId` without echoing full record metadata).
 */
export const DistillerChoiceOutputSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('update'),
    targetId: z.string().regex(/^[RL][1-9]\d*$/),
    whyMatched: z.string().min(1),
    proposedText: z.string().min(1),
    proposedRole: z.string().min(1),
    proposedContext: z.array(z.string().min(1)).min(1).optional(),
    proposedRepos: z.array(z.string().min(1)).min(1).optional(),
    alsoRemoveIds: z.array(z.string().regex(/^[RL][1-9]\d*$/)).optional(),
  }),
  z.object({
    op: z.literal('add'),
    proposedText: z.string().min(1),
    proposedRole: z.string().min(1),
    proposedContext: z.array(z.string().min(1)).min(1).optional(),
    proposedRepos: z.array(z.string().min(1)).min(1).optional(),
    capMerge: MemoryCapMergeProposalSchema.optional(),
  }),
]);

/**
 * Inferred Distiller choice output type.
 */
export type DistillerChoiceOutput = z.infer<typeof DistillerChoiceOutputSchema>;

/**
 * Hydrated proposal choice returned to the caller by `memory_propose` in `resolved` mode.
 */
export const MemoryProposalChoiceSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('update'),
    targetId: z.string().regex(/^[RL][1-9]\d*$/),
    existingRecord: z.union([MemoryRuleRecordSchema, MemoryLessonRecordSchema]),
    whyMatched: z.string().min(1),
    proposedText: z.string().min(1),
    proposedRole: z.string().min(1),
    proposedContext: z.array(z.string().min(1)).min(1).optional(),
    proposedRepos: z.array(z.string().min(1)).min(1).optional(),
    alsoRemoveIds: z.array(z.string().regex(/^[RL][1-9]\d*$/)).optional(),
  }),
  z.object({
    op: z.literal('add'),
    proposedText: z.string().min(1),
    proposedRole: z.string().min(1),
    proposedContext: z.array(z.string().min(1)).min(1).optional(),
    proposedRepos: z.array(z.string().min(1)).min(1).optional(),
    capMerge: MemoryCapMergeProposalSchema.optional(),
  }),
]);

/**
 * Inferred hydrated proposal choice union type.
 */
export type MemoryProposalChoice = z.infer<typeof MemoryProposalChoiceSchema>;

/**
 * Structured output schema that the Distiller LLM must produce.
 */
export const DistillerStructuredOutputSchema = z.object({
  matchStatus: z.enum([
    'NO_MATCH',
    'LIKELY_MATCH',
    'EXACT_DUPLICATE',
    'REJECTED_TIER_1_OR_2',
  ]),
  tierRejectionReason: z.string().min(1).optional(),
  recommendedChoiceIndex: z.number().int().min(-1),
  choices: z.array(DistillerChoiceOutputSchema),
});

/**
 * Inferred Distiller structured output type.
 */
export type DistillerStructuredOutput = z.infer<typeof DistillerStructuredOutputSchema>;

/**
 * Input schema for `memory_propose`.
 *
 * @note
 * `type` is restricted to `'rule' | 'lesson'`. Operational `'note'` records are committed directly via `memory_commit`.
 */
export const MemoryProposeInputSchema = z.object({
  callerRole: z.string().min(1),
  targetRole: z.string().min(1),
  type: z.enum(['rule', 'lesson']),
  rawText: z.string().min(1),
  context: z.array(z.string().min(1)).min(1).optional(),
  repos: z.array(z.string().min(1)).min(1).optional(),
  incident: z.string().min(1).max(1000).optional(),
});

/**
 * Inferred input type for `memory_propose`.
 */
export type MemoryProposeInput = z.infer<typeof MemoryProposeInputSchema>;

/**
 * Output schema for `memory_propose`, discriminated by `executionMode`.
 */
export const MemoryProposeOutputSchema = z.discriminatedUnion('executionMode', [
  z.object({
    executionMode: z.literal('resolved'),
    type: z.enum(['rule', 'lesson']),
    requiresOwnerGo: z.boolean(),
    bucketStatus: MemoryBucketStatusSchema,
    matchStatus: z.enum([
      'NO_MATCH',
      'LIKELY_MATCH',
      'EXACT_DUPLICATE',
      'REJECTED_TIER_1_OR_2',
    ]),
    tierRejectionReason: z.string().min(1).optional(),
    recommendedChoiceIndex: z.number().int().min(-1),
    choices: z.array(MemoryProposalChoiceSchema),
  }),
  z.object({
    executionMode: z.literal('delegate_to_subagent'),
    type: z.enum(['rule', 'lesson']),
    requiresOwnerGo: z.boolean(),
    bucketStatus: MemoryBucketStatusSchema,
    delegateToSubagent: z.object({
      model: z.string().min(1),
      effort: z.enum(['low', 'medium', 'high']),
      systemPrompt: z.string().min(1),
      userPrompt: z.string().min(1),
      outputJsonSchema: z.record(z.string(), z.unknown()),
    }),
  }),
]);

/**
 * Inferred output type for `memory_propose`.
 */
export type MemoryProposeOutput = z.infer<typeof MemoryProposeOutputSchema>;
```

**Behavioral & Validation Contract for `memory_propose`:**
1. Validate `callerRole` and `targetRole` against `config.allowedRoles`. Normalize `context` (if provided) via `normalizeMemoryPathPattern`.
2. Compute `bucketStatus` for a synthetic candidate `{ type: input.type, role: input.targetRole, context: normalizedContext, repos: input.repos }` using §5.2.
3. Build the **Prompt-Cached Distiller Prompt**:
   - **`systemPrompt` (static prefix for KV-caching):** Contains the Distiller instructions, `config.format` rules, `config.distiller.customInstructions`, the current repository's role rule files (`CLAUDE.MD`, `docs/rules/*.md` when present), and all active `R*` and `L*` records in `memory.jsonl` ordered deterministically.
   - **`userPrompt` (dynamic suffix):** Contains the candidate `{ type, targetRole, rawText, normalizedContext, repos, incident }`, the target `bucketStatus` (`zone`, `currentCount`, `softCap`, `hardCap`), and the strict rule that in `SOFT_CAP_PRESSURE` or `AT_HARD_CAP`, `capMerge` may be proposed **only** if two existing records of the same `type` in the target bucket share the exact same underlying failure mechanism.
4. **Runner Dispatch (`config.distiller.runner`):**
   - If `config.distiller.runner === 'claude-cli'` (or if `runner === 'subagent'` and an in-process `MemoryDistillerRunner` port is injected into `MemoryHarnessOptions`):
     - Execute `distillerRunner.runDistillerProposal(...)`, parse the output through `DistillerStructuredOutputSchema`, hydrate `existingRecord` from `memory.jsonl` for every `op: 'update'` choice, and deterministically validate every choice:
       - If `input.type === 'lesson'`, verify that every `choice.proposedText` (and any `choice.capMerge.mergedText`) passes `validateLessonTextFormat(text, config.format)` (§6.7).
       - Verify that when `input.type === 'lesson'`, no `alsoRemoveIds` or `capMerge` references an `R*` rule record.
       - Verify that `capMerge.keepId` and `capMerge.removeId` are distinct IDs of the same `type` currently residing in the target bucket `B`.
     - Return `executionMode: 'resolved'` with `requiresOwnerGo: input.type === 'rule' || choices.some((c) => c.op === 'update' && c.targetId.startsWith('R'))`.
   - If `config.distiller.runner === 'subagent'` and no in-process `MemoryDistillerRunner` is injected (standalone MCP stdio server mode):
     - Convert `DistillerStructuredOutputSchema` via `z.toJSONSchema(DistillerStructuredOutputSchema)` and return `executionMode: 'delegate_to_subagent'` so the calling agent invokes its native subagent tool with `delegateToSubagent` and passes the selected choice to `memory_commit`.

---

### 6.5 Tool 4: `memory_commit`

Atomically adds, updates, or removes a record in `memory.jsonl`.

```ts
/**
 * Input schema for `memory_commit`, discriminated by `op` (`'add' | 'update' | 'remove'`).
 */
export const MemoryCommitInputSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('add'),
      callerRole: z.string().min(1),
      type: MemoryRecordTypeSchema,
      role: z.string().min(1),
      text: z.string().min(1),
      context: z.array(z.string().min(1)).min(1).optional(),
      repos: z.array(z.string().min(1)).min(1).optional(),
      lifecycle: NoteLifecycleSchema.optional(),
      capMerge: z
        .object({
          keepId: z.string().regex(/^[RLN][1-9]\d*$/),
          removeId: z.string().regex(/^[RLN][1-9]\d*$/),
          mergedText: z.string().min(1),
        })
        .optional(),
    })
    .superRefine((val, ctx) => {
      if (val.type === 'note' && val.lifecycle === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['lifecycle'],
          message: 'lifecycle is required when adding a record with type "note".',
        });
      }
      if (val.type !== 'note' && val.lifecycle !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['lifecycle'],
          message: 'lifecycle is only permitted on records with type "note".',
        });
      }
      if (val.capMerge !== undefined) {
        if (val.capMerge.keepId === val.capMerge.removeId) {
          ctx.addIssue({
            code: 'custom',
            path: ['capMerge', 'removeId'],
            message: 'capMerge.keepId and capMerge.removeId must be distinct IDs.',
          });
        }
        const expectedPrefix = val.type === 'rule' ? 'R' : val.type === 'lesson' ? 'L' : 'N';
        if (
          !val.capMerge.keepId.startsWith(expectedPrefix) ||
          !val.capMerge.removeId.startsWith(expectedPrefix)
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['capMerge'],
            message: `capMerge IDs must match the added record prefix '${expectedPrefix}'.`,
          });
        }
      }
    }),
  z.object({
    op: z.literal('update'),
    callerRole: z.string().min(1),
    id: z.string().regex(/^[RLN][1-9]\d*$/),
    text: z.string().min(1),
    role: z.string().min(1).optional(),
    context: z.array(z.string().min(1)).min(1).nullable().optional(),
    repos: z.array(z.string().min(1)).min(1).nullable().optional(),
    lifecycle: NoteLifecycleSchema.optional(),
    alsoRemoveIds: z.array(z.string().regex(/^[RLN][1-9]\d*$/)).optional(),
  }),
  z.object({
    op: z.literal('remove'),
    callerRole: z.string().min(1),
    id: z.string().regex(/^[RLN][1-9]\d*$/),
    reason: z.enum([
      'owner_veto',
      'promoted_to_tier1_or_tier2',
      'merged_into_wider_record',
      'note_settled_or_obsolete',
    ]),
  }),
]);

/**
 * Inferred input type for `memory_commit`.
 */
export type MemoryCommitInput = z.infer<typeof MemoryCommitInputSchema>;

/**
 * Output schema for `memory_commit`.
 */
export const MemoryCommitOutputSchema = z.object({
  op: z.enum(['add', 'update', 'remove']),
  committedRecord: MemoryRecordSchema.nullable(),
  previousRecord: MemoryRecordSchema.nullable(),
  mergedKeepRecord: MemoryRecordSchema.nullable(),
  removedIds: z.array(z.string().regex(/^[RLN][1-9]\d*$/)),
  bucketStatusAfter: MemoryBucketStatusSchema.nullable(),
  gitCommitted: z.boolean(),
  gitPushed: z.boolean(),
});

/**
 * Inferred output type for `memory_commit`.
 */
export type MemoryCommitOutput = z.infer<typeof MemoryCommitOutputSchema>;
```

**Behavioral & Concurrency Contract for `memory_commit`:**
1. Validate `callerRole` (and `role` if present) against `config.allowedRoles`. Normalize any `context` array via `normalizeMemoryPathPattern`.
2. **Pre-Lock Format Gate (`validateLessonTextFormat`):**
   - If `op === 'add' && type === 'lesson'`, validate `input.text` against `config.format`.
   - If `op === 'add' && type === 'lesson' && input.capMerge !== undefined`, validate `input.capMerge.mergedText` against `config.format`.
   - If `op === 'update' && input.id.startsWith('L')`, validate `input.text` against `config.format`.
3. Acquire `<ledgerPath>.lock` via `withFileLock`:
   - Load `memory.jsonl` and `memory.meta.json`, and purge any `hard-expiry` notes with `nowMs >= Date.parse(expiresAt)`.
   - **On `op === 'add'`:**
     - Evaluate the target bucket `B` and `bucketStatus` (§5.2–§5.3).
     - If `input.capMerge` is provided: verify both `keepId` and `removeId` exist in bucket `B` and match `input.type`. Update `keepId` with `mergedText` and `updatedAt: nowIso`, and delete `removeId`.
     - Check capacity after applying any `capMerge`: if `(hardCap !== null && nextBucketCount > hardCap)` or `(config.maxTotalRecords !== undefined && nextTotalCount > config.maxTotalRecords)`, throw `MemoryHarnessError` (`'CAP_EXCEEDED'`) without modifying disk.
     - Allocate the next monotonic ID (`R<n>`, `L<n>`, or `N<n>`) per §3.1, construct the new `MemoryRecord` with `createdAt: nowIso`, insert in canonical order, and write `memory.jsonl` + `memory.meta.json` atomically.
   - **On `op === 'update'`:**
     - Locate existing record `target` with `target.id === input.id`; if absent, throw `MemoryHarnessError` (`'RECORD_NOT_FOUND'`).
     - If `input.lifecycle !== undefined && target.type !== 'note'`, throw `MemoryHarnessError` (`'VALIDATION_FAILED'`).
     - If `input.alsoRemoveIds` is provided:
       - Verify none of `alsoRemoveIds` equals `input.id` and all exist in `memory.jsonl`.
       - **Rule Protection Check:** If `target.type !== 'rule'` and any ID in `alsoRemoveIds` starts with `'R'`, throw `MemoryHarnessError` (`'RULE_PROTECTION_VIOLATION'`).
       - Remove all records in `alsoRemoveIds`.
     - Compute the updated record (`text: input.text.trim()`, `role: input.role ?? target.role`, `context: input.context === null ? undefined : (input.context ?? target.context)`, `repos: input.repos === null ? undefined : (input.repos ?? target.repos)`, `lifecycle: input.lifecycle ?? target.lifecycle`, `updatedAt: nowIso`).
     - If `role` or `context` changed such that the record moved into a different capacity bucket `B_new`, verify `B_new` does not exceed its `hardCap` (throwing `MemoryHarnessError` with `'CAP_EXCEEDED'` if `B_new.count + 1 > B_new.hardCap`).
     - Persist `memory.jsonl` atomically.
   - **On `op === 'remove'`:**
     - Locate and remove `input.id` (throwing `MemoryHarnessError` with `'RECORD_NOT_FOUND'` if absent), leaving `memory.meta.json` `highWaterMarks` untouched so `input.id` is never reused. Persist `memory.jsonl` atomically.
   - Run the Git auto-commit/push step (§8.2) while holding `<ledgerPath>.lock`.

---

### 6.6 Tool 5: `memory_drain_notes`

Safely previews (`dryRun: true`) and bulk-drains (`dryRun: false`) operational notes matching explicit lifecycle modes, roles, paths, or IDs.

```ts
/**
 * Selector for note lifecycle modes in `memory_drain_notes`, where `'*'` selects all modes.
 */
export const DrainNoteModeSelectorSchema = z.enum([
  'persistent',
  'read-count',
  'hard-expiry',
  'soft-expiry',
  '*',
]);

/**
 * Input schema for `memory_drain_notes`.
 *
 * @note
 * `modes` is required and must contain at least one mode (or `'*'` to explicitly select all modes).
 * `dryRun` defaults to `true` so callers inspect candidate notes before draining.
 */
export const MemoryDrainNotesInputSchema = z.object({
  callerRole: z.string().min(1),
  modes: z.array(DrainNoteModeSelectorSchema).min(1),
  role: z.string().min(1).optional(),
  paths: z.array(z.string().min(1)).min(1).optional(),
  ids: z.array(z.string().regex(/^N[1-9]\d*$/)).min(1).optional(),
  dryRun: z.boolean().default(true),
});

/**
 * Inferred input type for `memory_drain_notes`.
 */
export type MemoryDrainNotesInput = z.infer<typeof MemoryDrainNotesInputSchema>;

/**
 * Output schema for `memory_drain_notes`.
 */
export const MemoryDrainNotesOutputSchema = z.object({
  dryRun: z.boolean(),
  matchedNotes: z.array(MemoryNoteRecordSchema),
  drainedIds: z.array(z.string().regex(/^N[1-9]\d*$/)),
  gitCommitted: z.boolean(),
  gitPushed: z.boolean(),
});

/**
 * Inferred output type for `memory_drain_notes`.
 */
export type MemoryDrainNotesOutput = z.infer<typeof MemoryDrainNotesOutputSchema>;
```

**Behavioral Contract for `memory_drain_notes`:**
1. Validate `callerRole` (and `input.role` if provided) against `config.allowedRoles`. Normalize `input.paths` (if provided) via `normalizeMemoryPathPattern`.
2. Acquire `<ledgerPath>.lock`:
   - Load `memory.jsonl` and filter all `type: 'note'` records applicable to `config.repoId` that satisfy **all** specified filters:
     - **Lifecycle mode filter:** `input.modes.includes('*') || input.modes.includes(note.lifecycle.mode)`.
     - **Role filter:** `input.role === undefined || note.role === input.role`.
     - **Path filter:** `input.paths === undefined || (note.context !== undefined && matchesContextScope(normalizedPaths, note.context, repoFiles))`.
     - **ID filter:** `input.ids === undefined || input.ids.includes(note.id)`.
   - If `input.dryRun === true`: return `{ dryRun: true, matchedNotes, drainedIds: [], gitCommitted: false, gitPushed: false }` without mutating `memory.jsonl`.
   - If `input.dryRun === false`: remove `matchedNotes` from `memory.jsonl`, persist `memory.jsonl` atomically (preserving `memory.meta.json` `highWaterMarks`), execute Git commit/push if configured (§8.2), and return `{ dryRun: false, matchedNotes, drainedIds: matchedNotes.map((n) => n.id), gitCommitted, gitPushed }`.

---

### 6.7 Deterministic Lesson Format Validation (`validateLessonTextFormat`)

Every `type: 'lesson'` text (`trimmed = rawText.trim()`) must pass all five deterministic checks before `memory_propose` (in `resolved` mode) or `memory_commit` accepts it:
1. **Length Bound:** `trimmed.length > 0 && trimmed.length <= config.format.maxChars`.
2. **Single-Sentence Check (when `config.format.requireSingleSentence === true`):**
   - Must not contain newline characters (`\n` or `\r`).
   - Must end with `.`.
   - Must not contain sentence-splitting punctuation followed by whitespace and an uppercase letter (`/[.!?]\s+[A-Z]/u`).
3. **Required Substrings:** For every substring `sub` in `config.format.requireSubstrings`, `trimmed.includes(sub)` must be `true` (and for `' because '`, both the action clause before `' because '` and the mechanism clause after `' because '` must be at least 10 characters long).
4. **Forbidden Regexes:** For every pattern `pat` in `config.format.forbidRegexes`, `new RegExp(pat, 'u').test(trimmed)` must be `false`.
5. If any check fails, throw `MemoryHarnessError` with code `'LESSON_FORMAT_INVALID'` naming the exact failed check and quoting the offending substring or match.

---

## 7. Just-In-Time File-Interaction Hook & Compaction-Epoch Deduplication

### 7.1 Hook Input/Output Schemas & Trigger Surfaces

The File-Interaction Hook automatically surfaces context-scoped rules, lessons, and active notes on the **first** interaction with a matching file, directory, or glob after session start or after the latest context compaction:

```ts
import { z } from 'zod';
import {
  MemoryLessonRecordSchema,
  MemoryRuleRecordSchema,
} from './memory-record.schema.js';
import { MemoryLoadedNoteRecordSchema } from './memory-tools.schema.js';

/**
 * Normalized input payload passed to `MemoryHarness.handleFileInteractionHook`.
 */
export const FileInteractionHookInputSchema = z.object({
  sessionId: z.string().min(1),
  role: z.string().min(1).optional(),
  transcriptPath: z.string().min(1).optional(),
  touchedPaths: z.array(z.string().min(1)).min(1),
});

/**
 * Inferred input type for the file-interaction hook handler.
 */
export type FileInteractionHookInput = z.infer<typeof FileInteractionHookInputSchema>;

/**
 * Output payload returned by `MemoryHarness.handleFileInteractionHook`.
 */
export const FileInteractionHookOutputSchema = z.object({
  injected: z.boolean(),
  compactionEpochId: z.string().min(1),
  formattedContext: z.string().nullable(),
  rules: z.array(MemoryRuleRecordSchema),
  lessons: z.array(MemoryLessonRecordSchema),
  notes: z.array(MemoryLoadedNoteRecordSchema),
});

/**
 * Inferred output type for the file-interaction hook handler.
 */
export type FileInteractionHookOutput = z.infer<typeof FileInteractionHookOutputSchema>;
```

1. **Claude Code (`PostToolUse` Hook in `.claude/settings.json`):**
   - Matcher: `"Read|Edit|MultiEdit|Write|Grep|Glob|NotebookEdit"`.
   - Extracts candidate paths/globs from `tool_input.file_path`, `tool_input.path`, `tool_input.pattern`, or `tool_input.paths`.
   - When `output.injected === true`, writes JSON to `stdout`:
     ```json
     {
       "hookSpecificOutput": {
         "hookEventName": "PostToolUse",
         "additionalContext": "<output.formattedContext>"
       }
     }
     ```
2. **Antigravity (`.agents/hooks.json`):**
   - Inspects the latest tool invocation steps (`read_file`, `edit_file`, `write_file`, `grep_search`, `find_by_name`) in `transcript.jsonl` since the last hook checkpoint and returns `{ "injectSteps": [{ "systemMessage": { "systemMessage": "<output.formattedContext>" } }] }` when `output.injected === true`.

---

### 7.2 Compaction-Epoch State Schema & Deduplication Algorithm

```ts
import { z } from 'zod';

/**
 * Per-session deduplication state persisted at `.memory/.session-state/<sessionId>.json`.
 */
export const MemorySessionEpochStateSchema = z.object({
  sessionId: z.string().min(1),
  role: z.string().min(1),
  lastCompactionCheckpointId: z.string().min(1),
  seenRecordIds: z.array(z.string().regex(/^[RLN][1-9]\d*$/)).default([]),
  updatedAt: z.iso.datetime(),
});

/**
 * Inferred per-session compaction-epoch deduplication state type.
 */
export type MemorySessionEpochState = z.infer<typeof MemorySessionEpochStateSchema>;
```

**Deduplication & Epoch Reset Algorithm:**
1. **Determine Current Compaction Checkpoint ID & Role (`resolveTranscriptEpochAndRole(transcriptPath)`):**
   - Scan `transcriptPath` (if provided and readable) for:
     - The last JSONL entry representing a context compaction boundary (`obj.type === 'CHECKPOINT'` in Antigravity transcripts, or `obj.type === 'compact_boundary' || obj.subtype === 'compact_boundary'` in Claude Code transcripts), extracting a stable identifier (`String(obj.step_index ?? obj.uuid ?? obj.created_at ?? lineNumber)`), or `'epoch-0'` if no compaction has occurred.
     - The latest `memory_init` tool call argument `role` in `transcriptPath` (used as fallback if `input.role` is omitted and `.memory/.session-state/<sessionId>.json` has not been created yet, with final fallback to `.memory/.session-state/latest-role.json`).
2. **Load or Reset Session State:**
   - Under a per-session lock (`withFileLock('.memory/.session-state/<sessionId>.lock')`), load `.memory/.session-state/<sessionId>.json`.
   - If the file does not exist or `state.lastCompactionCheckpointId !== currentCheckpointId`:
     - Reset `state.lastCompactionCheckpointId = currentCheckpointId` and `state.seenRecordIds = []`.
3. **Match & Filter Unseen Scoped Records:**
   - Normalize `input.touchedPaths` via `normalizeMemoryPathPattern` (silently skipping any path outside `workspaceRoot`).
   - Acquire `<ledgerPath>.lock`, query scoped records (`record.context !== undefined && record.context.length > 0`) for `(record.role === 'general' || record.role === resolvedRole)` and `config.repoId` where `matchesContextScope(touchedPaths, record.context, repoFiles)` is `true`, and filter to records whose `id` is **not** in `new Set(state.seenRecordIds)`.
   - If the filtered list is empty, release locks and return `{ injected: false, compactionEpochId: currentCheckpointId, formattedContext: null, rules: [], lessons: [], notes: [] }`.
   - Otherwise, apply §3.3 lifecycle transitions (`read-count` and `soft-expiry`) to only the newly matched unseen `N*` notes, append all newly injected `R*`, `L*`, and `N*` IDs to `state.seenRecordIds`, atomically write both `memory.jsonl` (if any note transitioned) and `.memory/.session-state/<sessionId>.json`, and return `injected: true` with `formattedContext`.

---

## 8. Concurrency, Locking & Multi-Repo Git Synchronization

### 8.1 Lock Ordering & Atomic Persistence Invariants

1. **Lock Acquisition Order:** When both a session state lock (`.memory/.session-state/<sessionId>.lock`) and the ledger lock (`<ledgerPath>.lock`) are acquired, always acquire `.memory/.session-state/<sessionId>.lock` **first** and `<ledgerPath>.lock` **second**—never the reverse—so two concurrent hooks or tool calls can never deadlock.
2. **Atomic Write Requirement:** Every write to `memory.jsonl`, `memory.meta.json`, and `.memory/.session-state/<sessionId>.json` uses `write-file-atomic` (temp file in target directory + `fsync` + POSIX `rename`) inside `@paraharness/lockfile`'s `withFileLock`.
3. **Gitignored Ephemeral Files:** `.memory/*.lock`, `.memory/.session-state/`, and any `write-file-atomic` temporary files MUST be excluded in `<checkoutDir>/.gitignore` so ephemeral lock and session files are never committed to the memory Git repository.

---

### 8.2 Git Checkout Initialization, Auto-Commit & 3-Way Conflict-Free Reconcile (`config.storage.git`)

When `config.storage.git.enabled === true`:
1. **Checkout Initialization (`ensureMemoryGitCheckout`):**
   - Resolve `checkoutDir = path.resolve(workspaceRoot, config.storage.git.checkoutDir)`.
   - If `<checkoutDir>/.git` does not exist:
     - If `config.storage.git.remoteUrl !== undefined`, run `git clone --branch <branch> --single-branch <remoteUrl> <checkoutDir>` (or if the remote branch does not exist yet on an empty remote, `git init -b <branch> <checkoutDir>` + `git -C <checkoutDir> remote add origin <remoteUrl>`).
     - If `config.storage.git.remoteUrl === undefined`, run `git init -b <branch> <checkoutDir>`.
   - Ensure `<checkoutDir>/.gitignore` contains `.session-state/` and `*.lock`.
2. **Auto-Commit (`config.storage.git.autoCommit === true`):**
   - Inside `<ledgerPath>.lock`, after writing `memory.jsonl` and `memory.meta.json`:
   - Stage only the ledger and metadata files: `git -C <checkoutDir> add -- <relLedgerPath> <relMetaPath> .gitignore`.
   - Check `git -C <checkoutDir> status --porcelain -- <relLedgerPath> <relMetaPath> .gitignore`. If non-empty, commit with `git -C <checkoutDir> commit -m "memory(<repoId>): <opSummary>"`.
3. **Conflict-Free Multi-Repo Auto-Push (`config.storage.git.autoPush === true` and `remoteUrl` configured):**
   - Run `git -C <checkoutDir> push origin <branch>`.
   - If `git push` exits non-zero due to non-fast-forward remote updates (another repository or session pushed new memory records concurrently):
     1. Run `git -C <checkoutDir> fetch origin <branch>` and resolve `baseSha = git -C <checkoutDir> merge-base HEAD origin/<branch>`.
     2. Read `base` (`<baseSha>`), `local` (`HEAD`), and `remote` (`origin/<branch>`) versions of `<relLedgerPath>` and `<relMetaPath>` and reconcile them deterministically in-memory via `reconcileDivergedMemoryLedgers(base, local, remote)`:
        - **ID Collision Re-numbering:** If any record newly added in `local` (absent in `base`) has the same `id` (`R<n>`, `L<n>`, or `N<n>`) as a different record newly added in `remote` (absent in `base`, detected by differing `createdAt` or `text`), keep the `remote` record at `id` and re-number the `local` record to `${prefix}${nextMonotonicId}` above `Math.max(localMeta.highWaterMarks[P], remoteMeta.highWaterMarks[P])`.
        - **Three-Way Record Merge:**
          - A record present in `base` and deleted in `local` stays deleted unless `remote` updated it (`remote.updatedAt > base.updatedAt`).
          - A record present in `base` and deleted in `remote` stays deleted unless `local` updated it (`local.updatedAt > base.updatedAt`).
          - For records present in both `local` and `remote` with the same `id`, keep the version with the newer `updatedAt ?? createdAt` timestamp (for `read-count` notes, set `remainingReads = Math.min(local.remainingReads, remote.remainingReads)`).
        - **High-Water-Mark Merge:** For each prefix `P` in `['R', 'L', 'N']`, set `mergedMeta.highWaterMarks[P] = Math.max(localMeta.highWaterMarks[P], remoteMeta.highWaterMarks[P], maxNumericIdInMergedRecords(P))`.
     3. Reset `<checkoutDir>` branch to `origin/<branch>` (`git -C <checkoutDir> reset --hard origin/<branch>`), write `mergedRecords` and `mergedMeta` atomically, create the reconciled commit, and re-run `git -C <checkoutDir> push origin <branch>` (retrying up to 3 times on concurrent races, throwing `MemoryHarnessError` with `'GIT_SYNC_FAILED'` if still failing).

---

## 9. Core TypeScript Interfaces & Module Organization (`@paraharness/memory`)

### 9.1 Port & Coordinator Interfaces

```ts
import type { MemoryConfig } from './schemas/memory-config.schema.js';
import type {
  DistillerStructuredOutput,
  FileInteractionHookInput,
  FileInteractionHookOutput,
  MemoryBucketStatus,
  MemoryCommitInput,
  MemoryCommitOutput,
  MemoryDrainNotesInput,
  MemoryDrainNotesOutput,
  MemoryInitInput,
  MemoryInitOutput,
  MemoryLoadScopedInput,
  MemoryLoadScopedOutput,
  MemoryProposeInput,
  MemoryProposeOutput,
} from './schemas/memory-tools.schema.js';

/**
 * Request payload passed to an injected `MemoryDistillerRunner` during `memory_propose`.
 */
export interface DistillerProposalRequest {
  /** Model identifier from `config.distiller.model`. */
  readonly model: string;
  /** Reasoning effort level from `config.distiller.effort`. */
  readonly effort: 'low' | 'medium' | 'high';
  /** Execution timeout in milliseconds from `config.distiller.timeoutMs`. */
  readonly timeoutMs: number;
  /** Prompt-cached system prompt containing rules, format constraints, and existing ledger records. */
  readonly systemPrompt: string;
  /** Dynamic user prompt containing the candidate text, incident context, and target bucket status. */
  readonly userPrompt: string;
  /** Target bucket capacity status. */
  readonly bucketStatus: MemoryBucketStatus;
}

/**
 * Port interface for executing the Distiller LLM (`claude-cli` or in-process orchestrator subagent).
 */
export interface MemoryDistillerRunner {
  /**
   * Executes the Distiller prompt and returns a validated structured proposal.
   *
   * @param {DistillerProposalRequest} request - Distiller prompt and model parameters.
   *
   * @returns {Promise<DistillerStructuredOutput>} Structured Distiller match and choice analysis.
   */
  runDistillerProposal(request: DistillerProposalRequest): Promise<DistillerStructuredOutput>;
}

/**
 * Initialization options for `MemoryHarness`.
 */
export interface MemoryHarnessOptions {
  /** Absolute path to the repository workspace root. */
  readonly workspaceRoot: string;
  /** Optional explicit path to `memory.config.json` (overrides `.agents/` and `.claude/` discovery). */
  readonly configPath?: string;
  /** Optional injected Distiller runner (used for `'claude-cli'` or in-process `'subagent'` execution). */
  readonly distillerRunner?: MemoryDistillerRunner;
  /** Optional clock override returning current UTC epoch milliseconds (defaults to `Date.now`). */
  readonly nowMs?: () => number;
}

/**
 * Public programmatic contract of the Unified Memory Harness (`MemoryHarness`).
 */
export interface MemoryHarnessContract {
  /** Returns the loaded and validated `MemoryConfig`. */
  getConfig(): MemoryConfig;
  /** Executes `memory_init` at session start and after compaction. */
  init(input: MemoryInitInput): Promise<MemoryInitOutput>;
  /** Executes `memory_load_scoped` for specific paths or glob patterns. */
  loadScoped(input: MemoryLoadScopedInput): Promise<MemoryLoadScopedOutput>;
  /** Executes `memory_propose` to format and deduplicate a rule or lesson candidate. */
  propose(input: MemoryProposeInput): Promise<MemoryProposeOutput>;
  /** Executes `memory_commit` to atomically add, update, or remove a record. */
  commit(input: MemoryCommitInput): Promise<MemoryCommitOutput>;
  /** Executes `memory_drain_notes` in dry-run or destructive mode. */
  drainNotes(input: MemoryDrainNotesInput): Promise<MemoryDrainNotesOutput>;
  /** Evaluates a file/directory tool interaction and returns unseen scoped memories for the current compaction epoch. */
  handleFileInteractionHook(input: FileInteractionHookInput): Promise<FileInteractionHookOutput>;
}
```

---

### 9.2 Single-Kind Module Table (`packages/memory/`)

In accordance with `docs/CODING_GUIDELINES.md` Rules 1.1–1.8, `@paraharness/memory` is organized into single-kind entity files:

| File Path | Entity Kind (`Rule 1.1`) | Primary Export & Responsibility |
| :--- | :---: | :--- |
| `src/schemas/memory-config.schema.ts` | `*.schema.ts` | `MemoryConfigSchema`, `MemoryCapRuleSchema`, `MemoryLessonFormatConfigSchema`, `MemoryDistillerConfigSchema`, `MemoryStorageConfigSchema`, `MemoryGitStorageConfigSchema` and inferred types. |
| `src/schemas/memory-record.schema.ts` | `*.schema.ts` | `MemoryRecordSchema`, `MemoryRuleRecordSchema`, `MemoryLessonRecordSchema`, `MemoryNoteRecordSchema`, `NoteLifecycleSchema`, `MemoryMetaSchema` and inferred types. |
| `src/schemas/memory-tools.schema.ts` | `*.schema.ts` | Input/output Zod schemas and inferred types for `memory_init`, `memory_load_scoped`, `memory_propose`, `memory_commit`, `memory_drain_notes`, `FileInteractionHookInputSchema`, `FileInteractionHookOutputSchema`, `MemorySessionEpochStateSchema`, and `MemoryErrorCodeSchema`. |
| `src/memory-distiller-runner.ts` | `interface` | `MemoryDistillerRunner` and reachable `DistillerProposalRequest` sub-interface (`Rule 1.2`). |
| `src/memory-harness-options.ts` | `interface` | `MemoryHarnessOptions` configuration and dependency injection interface. |
| `src/memory-harness-contract.ts` | `interface` | `MemoryHarnessContract` programmatic surface interface. |
| `src/memory-harness-error.ts` | `class` | `MemoryHarnessError` structured domain error carrying `code: MemoryErrorCode` and `details?: Readonly<Record<string, unknown>>`. |
| `src/memory-harness.ts` | `class` | `MemoryHarness` stateful coordinator implementing `MemoryHarnessContract`. |
| `src/internal/load-memory-config.ts` | `function` | Discovers and validates `.agents/memory.config.json` $\to$ `.claude/memory.config.json` (§2.1). |
| `src/internal/normalize-memory-path-pattern.ts` | `function` | Normalizes paths/globs to repo-relative POSIX form (§4.1). |
| `src/internal/matches-context-scope.ts` | `function` | Implements the 4-way symmetric path/glob matching algorithm (§4.3). |
| `src/internal/resolve-record-cap-bucket.ts` | `function` | Implements the most-specific-bucket-wins specificity ranking and bucket partitioning (§5.2). |
| `src/internal/validate-lesson-text-format.ts` | `function` | Enforces deterministic string, single-sentence, required-substring, and forbidden-regex gates (§6.7). |
| `src/internal/evaluate-note-lifecycle-on-read.ts` | `function` | Evaluates `persistent`, `read-count`, `hard-expiry`, and `soft-expiry` transitions (§3.3). |
| `src/internal/reconcile-diverged-memory-ledgers.ts` | `function` | Pure 3-way record union, ID collision re-numbering, and high-water-mark reconciliation for concurrent multi-repo Git pushes (§8.2). |
| `src/index.ts` | Barrel | Explicit `export` and `export type` surface of `@paraharness/memory` (`Rule 1.7`). |

---

## 10. Role Skill Integration (`peer/SKILL.md`)

When `@paraharness/memory` is enabled in a repository:
1. Delete static `skills/lesson/SKILL.md`, `LESSONS.md`, `lessons/<ROLE>.md`, and `peer-notes.md`.
2. In `skills/peer/SKILL.md`:
   - Under `## Debate and decision` (line 34), tighten the execution gate so mixed agreement+question turns stay in prose:
     > *"An instruction to act needs no special phrasing. Carry it out in the same turn, without asking again, when no part of the turn is still an open question and the change is either trivial with one valid solution or already settled between you. When building it would mean making a choice the owner has not seen, lay out the options with your pick and build once they choose."*
   - Under `## Proposals, prior decisions, and open questions` and `## Sources of truth, documents, and subagents`:
     - Replace `peer-notes.md` and `skills/lesson/SKILL.md` references with the unified memory tools:
       > *"At session start and after every compaction, call `memory_init({ role: 'peer' })` before your first reply. When open questions or gaps come in, check the loaded notes and rules (and call `memory_load_scoped` for the relevant paths), the specs, and the code before asking the owner anything."*
       > *"When the owner signs off on a design or tells you to record now, log the settled choice, its reason, and any accepted trade-off as a `persistent` note via `memory_commit`, keeping anything still open in prose. When a mistake or lesson candidate survives mechanical and doc fixes, or when the owner states a `rule: <text>`, run `memory_propose` and `memory_commit` per the memory protocol."*
