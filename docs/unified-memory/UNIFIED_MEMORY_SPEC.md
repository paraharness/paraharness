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
import {
  MemoryRecordTypeSchema,
  type MemoryRecordType,
} from './memory-record.schema.js';

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
  autoPullOnInit: z.boolean().default(true),
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
    autoPullOnInit: true,
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
        autoPullOnInit: true,
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
    if (allowedSet.size !== cfg.allowedRoles.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['allowedRoles'],
        message: 'allowedRoles must not contain duplicate role names.',
      });
    }
    for (let i = 0; i < cfg.caps.length; i += 1) {
      const cap = cfg.caps[i];
      if (cap === undefined) continue;
      if (new Set(cap.roles).size !== cap.roles.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['caps', i, 'roles'],
          message: 'Cap roles must not contain duplicate entries.',
        });
      }
      if (new Set(cap.types).size !== cap.types.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['caps', i, 'types'],
          message: 'Cap types must not contain duplicate entries.',
        });
      }
      if (cap.roles.includes('*') && cap.roles.length > 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['caps', i, 'roles'],
          message: 'Cap roles cannot mix "*" with specific role names.',
        });
      }
      for (const r of cap.roles) {
        if (r !== '*' && !allowedSet.has(r)) {
          ctx.addIssue({
            code: 'custom',
            path: ['caps', i, 'roles'],
            message: `Cap role '${r}' is not present in allowedRoles.`,
          });
        }
      }
      if (cap.paths.includes('*') && cap.paths.length > 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['caps', i, 'paths'],
          message: 'Cap paths cannot mix "*" with specific path or glob patterns.',
        });
      }
      for (let j = 0; j < cap.paths.length; j += 1) {
        const rawPath = cap.paths[j];
        if (rawPath === undefined || rawPath === '*') continue;
        const trimmed = rawPath.trim();
        const posix = trimmed
          .replaceAll('\\', '/')
          .replace(/\/+/g, '/')
          .replace(/^(\.\/)+/, '')
          .replace(/\/$/, '');
        const segments = posix.length === 0 ? [] : posix.split('/');
        if (
          trimmed.length === 0 ||
          posix.length === 0 ||
          trimmed.startsWith('/') ||
          /^[A-Za-z]:/.test(trimmed) ||
          /^[A-Za-z]:/.test(posix) ||
          segments.some((seg) => seg === '..' || seg === '.')
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['caps', i, 'paths', j],
            message: `Invalid cap path pattern '${rawPath}'.`,
          });
        }
      }
    }
    if (cfg.storage.git.autoPush && (!cfg.storage.git.autoCommit || cfg.storage.git.remoteUrl === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['storage', 'git', 'autoPush'],
        message: 'storage.git.autoPush requires storage.git.autoCommit === true and a non-empty storage.git.remoteUrl.',
      });
    }
    const normLedger = cfg.storage.ledgerPath
      .trim()
      .replaceAll('\\', '/')
      .replace(/\/+/g, '/')
      .replace(/^(\.\/)+/, '')
      .replace(/\/$/, '');
    const ledgerSegs = normLedger.length === 0 ? [] : normLedger.split('/');
    const hasInvalidLedgerPath =
      normLedger.length === 0 ||
      normLedger.startsWith('/') ||
      /^[A-Za-z]:/.test(normLedger) ||
      ledgerSegs.some((seg) => seg === '..' || seg === '.');
    if (hasInvalidLedgerPath) {
      ctx.addIssue({
        code: 'custom',
        path: ['storage', 'ledgerPath'],
        message: `Invalid storage.ledgerPath ('${cfg.storage.ledgerPath}'). Must be a relative path inside the workspace.`,
      });
    }
    if (cfg.storage.git.enabled) {
      const normCheckout = cfg.storage.git.checkoutDir
        .trim()
        .replaceAll('\\', '/')
        .replace(/\/+/g, '/')
        .replace(/^(\.\/)+/, '')
        .replace(/\/$/, '');
      const checkoutSegs = normCheckout === '.' || normCheckout === '' ? [] : normCheckout.split('/');
      const hasInvalidCheckoutPath =
        normCheckout.length === 0 ||
        normCheckout.startsWith('/') ||
        /^[A-Za-z]:/.test(normCheckout) ||
        (normCheckout !== '.' && checkoutSegs.some((seg) => seg === '..' || seg === '.'));
      if (hasInvalidCheckoutPath) {
        ctx.addIssue({
          code: 'custom',
          path: ['storage', 'git', 'checkoutDir'],
          message: `Invalid storage.git.checkoutDir ('${cfg.storage.git.checkoutDir}'). Must be a relative directory path inside the workspace.`,
        });
      }
      const insideCheckout =
        !hasInvalidLedgerPath &&
        !hasInvalidCheckoutPath &&
        (checkoutSegs.length === 0 ||
          (normLedger.startsWith(`${normCheckout}/`) && normLedger.length > normCheckout.length + 1));
      if (!insideCheckout) {
        ctx.addIssue({
          code: 'custom',
          path: ['storage', 'ledgerPath'],
          message: `storage.ledgerPath ('${cfg.storage.ledgerPath}') must resolve inside storage.git.checkoutDir ('${cfg.storage.git.checkoutDir}') when storage.git.enabled is true.`,
        });
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
   - If `<ledgerPath>` does not exist on disk during a read operation, the ledger is treated as empty (`[]`); during the first mutating operation, its parent directory, `<ledgerDir>/memory.meta.json`, and `<ledgerPath>` are created atomically.
   - On every write, records in `memory.jsonl` are written in canonical deterministic order: sorted first by `typeRank` (`rule: 0`, `lesson: 1`, `note: 2`), and second by ascending numeric suffix of `id` (`Number(id.slice(1))`).
2. **Monotonic High-Water-Mark Metadata File (`<ledgerDir>/memory.meta.json`):**
   - Co-located in the same directory as `memory.jsonl`, validated by `MemoryMetaSchema` (`src/schemas/memory-record.schema.ts` in §3.2), and protected by the same exclusive file lock (`<ledgerPath>.lock`).
   - Stores the highest numeric ID ever allocated for each prefix (`R`, `L`, `N`) so deleted or lazily drained IDs are **never reused**.
   - **Self-Healing Pre-Purge Reconciliation & Allocation Rule:**
     - Every operation acquiring `<ledgerPath>.lock` immediately reconciles `meta.highWaterMarks[P] = Math.max(meta.highWaterMarks[P], maxNumericIdInLedger(rawLoadedRecords, P))` for each prefix `P` in `['R', 'L', 'N']` across all raw loaded records in `memory.jsonl` **before** purging expired `hard-expiry` notes or removing any records.
     - If `memory.meta.json` does not exist yet on first run, initialize it from `maxNumericIdInLedger` across current raw `memory.jsonl` records (and `git log -p -S '"id":"' -- <ledgerPath>` if inside a Git checkout with prior history).
     - Before allocating a new ID for prefix `P` (`'R' | 'L' | 'N'`), compute `effectiveMax = Math.max(meta.highWaterMarks[P], maxNumericIdInLedger(records, P))`, allocate `${P}${effectiveMax + 1}`, and set `meta.highWaterMarks[P] = effectiveMax + 1`.
     - Whenever `memory.meta.json` is created or `highWaterMarks` advances, atomically persist `memory.meta.json` **before** writing `memory.jsonl` per §8.1 Rule 2 so a crash between the two writes can never leave a record in `memory.jsonl` (or a subsequently drained record) with an unrecorded ID.

---

### 3.2 Note Lifecycle & Record Zod Schemas (`memory-record.schema.ts`)

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

---

### 3.3 Note Lifecycle State Machine & Lazy Drainage Contract

Let `nowMs = Date.now()` (UTC epoch milliseconds) at the moment a read or write operation inspects `memory.jsonl` under the exclusive file lock:

| Lifecycle Mode | Condition When Note Is Matched by a Read Operation (`memory_init`, `memory_load_scoped`, or File Hook) | Returned to Caller on This Read? | Ledger Mutation Applied Under Lock |
| :--- | :--- | :---: | :--- |
| **`persistent`** | Always | **Yes** (`drainedOnThisRead: false`, `renderedText: note.text`) | None (remains in `memory.jsonl` until removed via `memory_commit({ op: 'remove' })` or `memory_drain_notes`). |
| **`read-count`** | `remainingReads > 1` | **Yes** (`drainedOnThisRead: false`, `lifecycle.remainingReads: remainingReads - 1`, `renderedText: note.text`) | Decrement `lifecycle.remainingReads` to `remainingReads - 1` without setting or updating `note.updatedAt` (`note.updatedAt` is set or updated exclusively by `memory_commit({ op: 'update' })`), and persist `memory.jsonl` (and Git auto-commit/push per §8.2 if configured). |
| **`read-count`** | `remainingReads === 1` | **Yes** (`drainedOnThisRead: true`, `lifecycle.remainingReads: 1`, `renderedText: "[FINAL READ - DRAINED] " + note.text`) | Delete record from `memory.jsonl` and persist (and Git auto-commit/push per §8.2 if configured). |
| **`hard-expiry`** | `nowMs < Date.parse(expiresAt)` | **Yes** (`drainedOnThisRead: false`, `renderedText: note.text`) | None. |
| **`hard-expiry`** | `nowMs >= Date.parse(expiresAt)` | **No** (omitted from response) | Delete record from `memory.jsonl` and persist (purged on any ledger read or write under `<ledgerPath>.lock` after reconciling `memory.meta.json` `highWaterMarks`, and excluded from active snapshots during read-only operations). |
| **`soft-expiry`** | `nowMs < Date.parse(expiresAt)` | **Yes** (`drainedOnThisRead: false`, `renderedText: note.text`) | None. |
| **`soft-expiry`** | `nowMs >= Date.parse(expiresAt)` | **Yes** (`drainedOnThisRead: true`, `renderedText: "[FINAL READ - DRAINED] " + note.text`) | Delete record from `memory.jsonl` and persist immediately after constructing the read response (and Git auto-commit/push per §8.2 if configured). |

**Scoping & Compaction Drainage Invariants:**
1. **Unscoped vs. Scoped Isolation:** `memory_init` selects only **unscoped** records (`context === undefined`). Therefore, `memory_init` MUST NOT decrement `remainingReads` or trigger `soft-expiry` final-read drainage on any **path-scoped** note (`context !== undefined`). Path-scoped notes are evaluated for `read-count` and `soft-expiry` transitions exclusively when matched and returned by `memory_load_scoped` or injected by the File-Interaction Hook.
2. **Hook Deduplication Protection:** When the File-Interaction Hook suppresses a scoped note because its `id` is already in `seenRecordIds` for the current compaction epoch, that suppressed touch is **not** a read and MUST NOT decrement `remainingReads` or trigger `soft-expiry` drainage.

---

## 4. Path Normalization & 4-Way Context Matching Contract

### 4.1 Path & Glob Normalization (`normalizeMemoryPathPattern`)

Every path or glob string passed in `record.context`, `memory_load_scoped.paths`, `memory_propose.context`, `memory_commit.context`, `memory_drain_notes.paths`, `config.caps[*].paths`, or extracted by the File-Interaction Hook MUST be normalized via `normalizeMemoryPathPattern(rawPath, workspaceRoot)` before storage or comparison:

1. Trim leading and trailing whitespace; if empty, throw `MemoryHarnessError` (`'VALIDATION_FAILED'`).
2. Replace all Windows path separators `\` with POSIX `/` and collapse consecutive slashes `//` into a single `/`.
3. Normalize `workspaceRoot` to POSIX without trailing slash (`workspaceRootPosix`, or `'/'` if filesystem root). If `normalized === '.' || normalized === './' || normalized === workspaceRootPosix || normalized === workspaceRootPosix + '/'`, return `'**/*'`.
4. If `normalized.startsWith(workspaceRootPosix + '/')`, strip the `workspaceRootPosix + '/'` prefix so it becomes workspace-relative.
5. Otherwise, if `normalized.startsWith('/')` or `/^[A-Za-z]:\//.test(normalized)` (an absolute path outside `workspaceRoot`), throw `MemoryHarnessError` (`'VALIDATION_FAILED'`).
6. Repeatedly strip any leading `./` prefixes, then strip any trailing `/` (so `'./packages/lockfile/'` normalizes to `'packages/lockfile'`).
7. If `normalized === '' || normalized === '.'`, return `'**/*'`.
8. Split on `/` and reject any segment equal to `'..'` or `'.'` with `MemoryHarnessError` (`'VALIDATION_FAILED'`) so patterns cannot escape the repository root.
9. When normalizing any path array (`record.context`, `paths`, `touchedPaths`, `caps[*].paths`), deduplicate the normalized strings while preserving first-seen order.

---

### 4.2 Pattern Classification & Static Prefix Extraction

1. **`isGlobPattern(normalized: string): boolean`:**
   Returns `true` if and only if `normalized` contains any glob metacharacter from the set `*`, `?`, `[`, `]`, `{`, `}`, `!`, or extglob prefixes `@(`, `+(`, `*(`, `?(`, `!(`, i.e., any glob syntax. Otherwise, `normalized` is classified as a **`specific`** path (identifying a specific file or directory path).
2. **`extractStaticDirPrefix(globPattern: string): string`:**
   Splits `globPattern` on `/`, collects all leading path segments that contain zero glob metacharacters, and joins them with `/` (returning `''` when the first segment contains a glob metacharacter, such as `'**/*.sql'`).

---

### 4.3 Four-Way Symmetric Matching (`matchesContextScope`)

Let:
- `buildRelativeProbes(pattern: string): readonly string[]` construct synthetic relative probe paths segment-wise: take the sub-pattern of `pattern` after `extractStaticDirPrefix(pattern)` (and the full `pattern`), expand any brace alternatives (`{a,b}`), split on `/`, replace each `'**'` segment with both `[]` (zero segments) and `['__sub__']` (one segment), and replace any glob metacharacter tokens (`*`, `?`, `[...]`, extglobs) in each remaining segment with `'__probe__'`—always including `'__probe__'` and `'__sub__/__probe__'` in the returned deduplicated list (so compound extensions like `'**/*.schema.ts'`, exact basenames like `'**/SKILL.md'`, and mid-segment globs like `'packages/memory/**/internal/*.ts'` all produce matching relative probes).
- `isDirectoryCandidate(s: string, repoFiles: readonly string[]): boolean` evaluate to `!repoFiles.includes(s) && (repoFiles.some((f) => f.startsWith(s + '/')) || path.posix.extname(s) === '')`.

Given normalized query items `Q = readonly string[]`, normalized record context items `C = readonly string[]`, and the repository's tracked relative file list `repoFiles = readonly string[]` (obtained via `git ls-files` cached per workspace tree state, falling back to `tinyglobby` when outside a Git worktree), `matchesContextScope(Q, C, repoFiles)` returns `true` if and only if there exists at least one `q` in `Q` and at least one `c` in `C` such that `matchSingleContextPair(q, c, repoFiles)` evaluates to `true` under one of the four exhaustive cases:

1. **Case 1 — Specific-to-Specific (`!isGlobPattern(q) && !isGlobPattern(c)`):**
   Returns `true` if and only if:
   - `q === c` (exact file or directory match), or
   - `q.startsWith(c + '/')` (`q` is a file or subdirectory inside directory `c`), or
   - `c.startsWith(q + '/')` (`c` is a file or subdirectory inside directory `q`).

2. **Case 2 — Specific-to-Pattern (`!isGlobPattern(q) && isGlobPattern(c)`):**
   Let `cPrefix = extractStaticDirPrefix(c)` and `cMatcher = picomatch(c, { dot: true })` (pre-compiled per `CODING_GUIDELINES.md` Rule 4.4). Returns `true` if and only if at least one holds:
   - `cMatcher(q)` is `true` (for example, `q = 'packages/lockfile/src/index.ts'` matches `c = 'packages/lockfile/**/*'`), or
   - `isDirectoryCandidate(q, repoFiles)` is `true` and there exists `relProbe` in `(cPrefix === '' && repoFiles.length > 0 ? ['__probe__', '__sub__/__probe__'] : buildRelativeProbes(c))` such that `cMatcher(q + '/' + relProbe)` is `true` (so directory `q = 'packages/lockfile'` matches `c = 'packages/lockfile/**'`, `c = 'packages/lockfile/**/*'`, or `c = 'packages/lockfile/**/*.ts'` even when `repoFiles` is empty, while unrooted file-type globs like `c = '**/*.sql'` match populated directories via Bullet 4 and never falsely match specific file paths like `q = 'packages/lockfile/src/index.ts'`), or
   - `cPrefix.length > 0 && (cPrefix === q || cPrefix.startsWith(q + '/'))` (for example, `q = 'packages'` or `q = 'packages/lockfile'` contains the pattern's static directory prefix `c = 'packages/lockfile/src/*.ts'`), or
   - There exists a file `f` in `repoFiles` such that `(f === q || f.startsWith(q + '/')) && cMatcher(f)` (for example, directory `q = 'packages/lockfile'` contains tracked file `'packages/lockfile/schema.sql'` matching `c = '**/*.sql'`).

3. **Case 3 — Pattern-to-Specific (`isGlobPattern(q) && !isGlobPattern(c)`):**
   Symmetric to Case 2 (`matchSingleContextPair(c, q, repoFiles)`):
   Let `qPrefix = extractStaticDirPrefix(q)` and `qMatcher = picomatch(q, { dot: true })`. Returns `true` if and only if at least one holds:
   - `qMatcher(c)` is `true`, or
   - `isDirectoryCandidate(c, repoFiles)` is `true` and there exists `relProbe` in `(qPrefix === '' && repoFiles.length > 0 ? ['__probe__', '__sub__/__probe__'] : buildRelativeProbes(q))` such that `qMatcher(c + '/' + relProbe)` is `true`, or
   - `qPrefix.length > 0 && (qPrefix === c || qPrefix.startsWith(c + '/'))`, or
   - There exists a file `f` in `repoFiles` such that `(f === c || f.startsWith(c + '/')) && qMatcher(f)`.

4. **Case 4 — Pattern-to-Pattern (`isGlobPattern(q) && isGlobPattern(c)`):**
   Let `qMatcher = picomatch(q, { dot: true })`, `cMatcher = picomatch(c, { dot: true })`, `qPrefix = extractStaticDirPrefix(q)`, and `cPrefix = extractStaticDirPrefix(c)`. Returns `true` if and only if at least one holds:
   - `q === c`, or
   - `qMatcher(c) || cMatcher(q)`, or
   - There exists a file `f` in `repoFiles` such that `qMatcher(f) && cMatcher(f)`, or
   - When `qPrefix` and `cPrefix` are hierarchically compatible (`qPrefix === '' || cPrefix === '' || qPrefix === cPrefix || qPrefix.startsWith(cPrefix + '/') || cPrefix.startsWith(qPrefix + '/')`), let `deeperPrefix = qPrefix.length >= cPrefix.length ? qPrefix : cPrefix` and `base = deeperPrefix === '' ? '' : deeperPrefix + '/'`, and test synthetic probe paths `probe = base + relProbe` for every `relProbe` in `buildRelativeProbes(q) ∪ buildRelativeProbes(c)`—returning `true` if `qMatcher(probe) && cMatcher(probe)` holds for any synthetic probe path.

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
     - If `r.context !== undefined` (scoped record): eligible if and only if `capRule.paths.includes('*')`, OR (`capRule.paths.length > 0` and for **every** context pattern `c` in `r.context`, there exists at least one `p` in `normalizedCapRulePaths` such that `isContextCoveredByCapPattern(p, c, repoFiles)` is `true`).
       - `isContextCoveredByCapPattern(p, c, repoFiles)` holds if and only if `pDirPrefix` is an ancestor-or-equal prefix of `cDirPrefix` (`pDirPrefix === '' || cDirPrefix === pDirPrefix || cDirPrefix.startsWith(pDirPrefix + '/')`, where `pDirPrefix = isGlobPattern(p) ? extractStaticDirPrefix(p) : p` and `cDirPrefix = isGlobPattern(c) ? extractStaticDirPrefix(c) : c`), AND when `isGlobPattern(p)` is `true` (with `pMatcher = picomatch(p, { dot: true })`):
         - (a) if `!isGlobPattern(c)` and `!isDirectoryCandidate(c, repoFiles)`: `pMatcher(c)` is `true`;
         - (b) if `!isGlobPattern(c)` and `isDirectoryCandidate(c, repoFiles)`: `pMatcher(c) || (pMatcher(c + '/__probe__') && pMatcher(c + '/__sub__/__probe__'))` is `true`;
         - (c) if `isGlobPattern(c)` (with `cMatcher = picomatch(c, { dot: true })` and `base = cDirPrefix === '' ? '' : cDirPrefix + '/'`): `p === c`, or for every `relProbe` in `buildRelativeProbes(c)` where `cMatcher(base + relProbe)` is `true`, `pMatcher(base + relProbe)` is also `true` (with at least one probe matching `cMatcher`).

2. **Specificity Tuple & Winning Rule Selection:**
   If zero rules in `config.caps` are eligible for `r`, then `r` is uncapped by `config.caps` (subject only to `config.maxTotalRecords` if set).
   If one or more rules are eligible, rank each eligible `capRule` at index `i` by the 6-tuple `(pathTier, maxPrefixSegments, maxPrefixChars, roleSpec, typeSpec, -i)` (where `pathSpec = (pathTier, maxPrefixSegments, maxPrefixChars)`) in descending lexicographical order and select the unique maximum:
   - `pathSpec = (pathTier, maxPrefixSegments, maxPrefixChars)`:
     - Unscoped rule (`r.context === undefined && capRule.paths.length === 0`): `(2, 0, 0)`.
     - Wildcard scoped fallback (`r.context !== undefined && capRule.paths.includes('*')`): `(1, 0, 0)`.
     - Explicit path/glob rule (`r.context !== undefined && !capRule.paths.includes('*')`): `(2, maxPrefixSegments, maxPrefixChars)`, where for each `c` in `r.context` we compute the maximum `(prefixSegments(p), prefixChars(p))` across all `p` in `normalizedCapRulePaths` satisfying `isContextCoveredByCapPattern(p, c, repoFiles)` (with `prefixSegments(p) = pDirPrefix === '' ? 0 : pDirPrefix.split('/').length` and `prefixChars(p) = pDirPrefix.length`), and the rule's `(maxPrefixSegments, maxPrefixChars)` for `r` is defined as the minimum of those maxima across all `c` in `r.context`.
   - `roleSpec`:
     - `2` if `capRule.roles.includes(r.role)` (explicit role match, e.g. `['builder']` or `['general']`).
     - `1` if matched only via `capRule.roles.includes('*')`.
   - `typeSpec`:
     - `2` if `capRule.types.length === 1`.
     - `1` if `capRule.types.length > 1`.
   - `-i`: Earlier array index `i` in `config.caps` wins ties.

3. **Partition Key (`bucketId`) & Bucket Population `B`:**
   - **When one or more rules in `config.caps` are eligible (winning rule `capRule[winIdx]`):**
     To ensure wildcard rules (`roles: ['*']` or `paths: ['*']`) give each role and each path scope its own independent budget rather than pooling unrelated roles or packages together, the bucket partition key for record `r` under winning rule `winIdx` is:
     - `rolePartition = capRule.roles.includes(r.role) ? capRule.roles.slice().sort().join(',') : 'role:' + r.role`
     - `pathPartition`:
       - If `r.context === undefined`: `'unscoped'`
       - Else if `!capRule.paths.includes('*')`: `'rule-paths:' + normalizedCapRulePaths.slice().sort().join('|')`
       - Else (`capRule.paths.includes('*')`): `'record-context:' + r.context.slice().sort().join('|')`
     - `bucketId = "rule#${winIdx}|role=${rolePartition}|path=${pathPartition}"`
     - All active records in `memory.jsonl` (for `config.repoId`) whose winning rule and `bucketId` match `r`'s `bucketId` form `r`'s bucket population `B` (`currentCount = B.length`, `bucketRecordIds = B.map((x) => x.id)` in §3.1 canonical order, `softCap = capRule.softCap`, `hardCap = capRule.hardCap`, and `zone = (currentCount >= hardCap || maxTotalRecordsReached) ? 'AT_HARD_CAP' : currentCount >= softCap ? 'SOFT_CAP_PRESSURE' : 'UNDER_SOFT_CAP'`).
   - **When zero rules in `config.caps` are eligible (`UNCAPPED` bucket):**
     - `bucketId = "uncapped|type=${r.type}|role=role:${r.role}|path=${r.context === undefined ? 'unscoped' : 'record-context:' + r.context.slice().sort().join('|')}"`
     - `B` = all active records in `memory.jsonl` (for `config.repoId`) with the same `bucketId` (`currentCount = B.length`, `bucketRecordIds = B.map((x) => x.id)` in §3.1 canonical order, `softCap = null`, `hardCap = null`, and `zone = maxTotalRecordsReached ? 'AT_HARD_CAP' : 'UNCAPPED'`).

---

### 5.3 Three-Zone Capacity Enforcement (`softCap`, `hardCap`, `maxTotalRecords`)

Let `count = B.length` be the number of existing records in the candidate's target bucket `B`, `totalCount` be the total active records for `config.repoId`, `maxTotalRecordsReached = config.maxTotalRecords !== undefined && totalCount >= config.maxTotalRecords`, and for a capped bucket `zone = (currentCount >= hardCap || maxTotalRecordsReached) ? 'AT_HARD_CAP' : currentCount >= softCap ? 'SOFT_CAP_PRESSURE' : 'UNDER_SOFT_CAP'`:

| Zone | Condition | `memory_propose` Behavior | `memory_commit({ op: 'add' })` Behavior |
| :--- | :--- | :--- | :--- |
| **Zone 1: Under Soft Cap** | `count < softCap` and `(maxTotalRecords === undefined \|\| totalCount < maxTotalRecords)` | Recommends `op: 'update'` if and only if the candidate shares the same mechanism/rule topic as an existing record; otherwise recommends `op: 'add'` with `capMerge: undefined`. | **Permitted** without `capMerge`. |
| **Zone 2: Soft Cap Consolidation Pressure** | `softCap <= count < hardCap` and `(maxTotalRecords === undefined \|\| totalCount < maxTotalRecords)` | Instructs the Distiller that bucket `B` is over `softCap` (`count / softCap`). If the candidate is a new mechanism, the Distiller scans `B` for two existing records with the same `type` and `role` (`keepRecord.type === removeRecord.type && keepRecord.role === removeRecord.role`) that **genuinely share the same underlying mechanism**. If found, attaches `capMerge: { keepId, removeId, mergedText, whyMerged }` to the `op: 'add'` choice. **If no pair in `B` shares a mechanism, `capMerge` MUST be `undefined`.** | **Permitted** both with `capMerge` (keeping net count at `count`) and without `capMerge` (incrementing count to `count + 1 <= hardCap`). |
| **Zone 3: At Hard Cap** | `count >= hardCap` or `(maxTotalRecords !== undefined && totalCount >= maxTotalRecords)` | Sets `bucketStatus.zone = 'AT_HARD_CAP'` (and `maxTotalRecordsReached = true` when `totalCount >= maxTotalRecords`). Any `op: 'add'` choice requires either `capMerge` (when two existing records in `B` with the same `type` and `role` share a mechanism) or the caller must choose `op: 'update'` / remove an obsolete record first. | **Rejected** with `MemoryHarnessError` (`'CAP_EXCEEDED'`) unless `op: 'add'` includes a valid `capMerge` whose `keepId` and `removeId` belong to bucket `B`, share the same `role` (`keepRecord.role === removeRecord.role`), and have the same `type` as the added record (keeping net bucket count `<= hardCap` and `totalCount <= maxTotalRecords`). |

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
 * Safe single-segment session identifier schema preventing path traversal and reserved filename collisions.
 */
export const SessionIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]+$/)
  .refine((s) => s !== 'latest-role', {
    message: 'sessionId cannot be the reserved identifier "latest-role".',
  });

/**
 * Inferred session identifier type.
 */
export type SessionId = z.infer<typeof SessionIdSchema>;

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
  bucketRecordIds: z.array(z.string().regex(/^[RLN][1-9]\d*$/)),
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
  sessionId: SessionIdSchema.optional(),
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
1. Validate `config.allowedRoles.includes(input.role)`. If invalid, throw `MemoryHarnessError` with code `'INVALID_ROLE'` and details containing `allowedRoles: config.allowedRoles`. If `input.sessionId !== undefined`, validate it strictly via `SessionIdSchema` (throwing `MemoryHarnessError` with `'VALIDATION_FAILED'` if invalid); otherwise parse fallback environment variables (`CLAUDE_SESSION_ID`, then `AGY_SESSION_ID`) via `SessionIdSchema.safeParse` (treating empty or non-matching environment values as `undefined`).
2. Acquire `.memory/.session-state/latest-role.lock` via `withFileLock`, atomically write `.memory/.session-state/latest-role.json` (`{ role: input.role, updatedAt: nowIso }` validated via `MemoryLatestRoleStateSchema` in §7.2), and release `latest-role.lock`.
3. If `sessionId` is present/resolved, acquire `.memory/.session-state/<sessionId>.lock` **first** and `<ledgerPath>.lock` **second** per §8.1 Rule 1 (if no `sessionId` is available, acquire `<ledgerPath>.lock` directly):
   - Inside `<ledgerPath>.lock`:
     - If `config.storage.git.enabled === true`, ensure the Git storage checkout is initialized (and when `config.storage.git.autoPullOnInit === true && config.storage.git.remoteUrl !== undefined`, run the best-effort session-start remote fetch and 3-way reconciliation) per §8.2.1.
     - Parse `memory.jsonl` and `memory.meta.json`, immediately reconcile `meta.highWaterMarks` across all raw loaded records per §3.1 before any purge, and delete any `type: 'note'` record with `lifecycle.mode === 'hard-expiry'` where `nowMs >= Date.parse(lifecycle.expiresAt)`.
     - Select all **unscoped** records (`record.context === undefined`) where `(record.role === 'general' || record.role === input.role)` and `(record.repos === undefined || record.repos.includes(config.repoId))`.
     - Apply the §3.3 lifecycle transition table to each selected unscoped `type: 'note'` record (`read-count` decrement/drainage and `soft-expiry` final-read drainage). When `drainedOnThisRead === true`, set `renderedText = "[FINAL READ - DRAINED] " + note.text` (retaining `lifecycle.remainingReads = 1` on `read-count` notes); otherwise set `renderedText = note.text` (and `lifecycle.remainingReads = remainingReads - 1` on `read-count` notes).
     - Follow the §8.1 Rule 2 multi-file write order: atomically write `memory.meta.json` first (whenever created or `highWaterMarks` advanced), atomically write `memory.jsonl` second (whenever any record was purged, decremented, or drained), and run §8.2 Git auto-commit/push third (when `config.storage.git.enabled && config.storage.git.autoCommit` and `memory.jsonl` or `memory.meta.json` was written).
   - While holding `.memory/.session-state/<sessionId>.lock` (when `sessionId` is present/resolved), atomically write `.memory/.session-state/<sessionId>.json` fourth with `sessionId`, `role: input.role`, `seenRecordIds: []`, `lastCompactionCheckpointId: 'PENDING_HOOK_EPOCH'`, and `updatedAt: nowIso` (preserving any existing `transcriptPath` and `lastScannedTranscriptOffset` if `<sessionId>.json` already existed).
4. Generate the config-adapted `protocol` markdown string containing:
   - The 3-tier lesson gate (Tier 1 test/type/linter/script $\to$ Tier 2 role/doc line $\to$ Tier 3 atomic lesson),
   - The project's exact `config.format` rules (`template`, `maxChars`, `requireSubstrings`, `forbidRegexes`) for lessons,
   - The `memory_propose` $\to$ `memory_commit` workflow for lessons and rules (including handling both `executionMode: 'resolved'` and `executionMode: 'delegate_to_subagent'` by invoking the host subagent with `delegateToSubagent` and passing the chosen `add` / `update` payload to `memory_commit`, and requiring explicit Owner `"go"` before committing any `type: 'rule'` record),
   - The `note` lifecycle modes (`persistent`, `read-count`, `hard-expiry`, `soft-expiry`) and `memory_drain_notes` dry-run-first workflow, and
   - When to call `memory_load_scoped({ role, paths })`.
5. Return `{ role: input.role, repoId: config.repoId, protocol, rules, lessons, notes }` sorted by numeric ID within each array.

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
  sessionId: SessionIdSchema.optional(),
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
2. Normalize and deduplicate `input.paths` via `normalizeMemoryPathPattern` (§4.1). If `input.sessionId !== undefined`, validate it strictly via `SessionIdSchema` (throwing `MemoryHarnessError` with `'VALIDATION_FAILED'` if invalid); otherwise parse fallback environment variables (`CLAUDE_SESSION_ID`, then `AGY_SESSION_ID`) via `SessionIdSchema.safeParse` (treating empty or non-matching environment values as `undefined`).
3. If `sessionId` is present/resolved, acquire `.memory/.session-state/<sessionId>.lock` **first** and `<ledgerPath>.lock` **second** per §8.1 Rule 1 (otherwise acquire `<ledgerPath>.lock` directly):
   - Inside `<ledgerPath>.lock`:
     - If `config.storage.git.enabled === true`, ensure the Git storage checkout is initialized per §8.2.1.
     - Parse `memory.jsonl` and `memory.meta.json`, immediately reconcile `meta.highWaterMarks` across all raw loaded records per §3.1 before any purge, and purge expired `hard-expiry` notes (`nowMs >= Date.parse(expiresAt)`).
     - Select all **scoped** records (`record.context !== undefined && record.context.length > 0`) where:
       - `(record.role === 'general' || record.role === input.role)`,
       - `(record.repos === undefined || record.repos.includes(config.repoId))`, and
       - `matchesContextScope(normalizedPaths, record.context, repoFiles)` (§4.3) is `true`.
     - Apply §3.3 lifecycle transitions (`read-count` and `soft-expiry`) to the matched scoped `N*` notes.
     - Follow the §8.1 Rule 2 multi-file write order: atomically write `memory.meta.json` first (whenever created or `highWaterMarks` advanced), atomically write `memory.jsonl` second (whenever any note was purged, decremented, or drained), and run §8.2 Git auto-commit/push third (when `config.storage.git.enabled && config.storage.git.autoCommit` and `memory.jsonl` or `memory.meta.json` was written).
   - If `sessionId` is present/resolved, merge all returned scoped `R*`, `L*`, and `N*` IDs (deduplicated) into `state.seenRecordIds` in `.memory/.session-state/<sessionId>.json` (initializing `lastCompactionCheckpointId: 'PENDING_HOOK_EPOCH'` and `lastScannedTranscriptOffset: 0` if `<sessionId>.json` did not exist yet, and updating `role: input.role` and `updatedAt: nowIso`), and atomically write `.memory/.session-state/<sessionId>.json` fourth per §8.1 Rule 2.
4. Return `{ role: input.role, normalizedPaths, rules, lessons, notes }` (never re-returning unscoped memories).

---

### 6.4 Tool 3: `memory_propose`

Runs (or prepares) the Distiller agent to format, deduplicate, and check capacity for a candidate `'rule'` or `'lesson'`.

```ts
/**
 * Consolidation merge payload attached to an `op: 'add'` choice when two existing records of the
 * same type in a bucket at or above `softCap` genuinely share the same underlying mechanism.
 */
export const MemoryCapMergeProposalSchema = z
  .object({
    keepId: z.string().regex(/^[RL][1-9]\d*$/),
    removeId: z.string().regex(/^[RL][1-9]\d*$/),
    mergedText: z.string().trim().min(1),
    whyMerged: z.string().trim().min(1),
  })
  .refine((m) => m.keepId !== m.removeId && m.keepId[0] === m.removeId[0], {
    message: 'keepId and removeId must be distinct IDs with the same type prefix.',
  });

/**
 * Inferred capacity-merge proposal type.
 */
export type MemoryCapMergeProposal = z.infer<typeof MemoryCapMergeProposalSchema>;

/**
 * Choice item produced directly by the Distiller LLM (referencing `targetId` without echoing full record metadata).
 */
export const DistillerChoiceOutputSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('update'),
      targetId: z.string().regex(/^[RL][1-9]\d*$/),
      whyMatched: z.string().trim().min(1),
      proposedText: z.string().trim().min(1),
      proposedRole: z.string().min(1),
      proposedContext: z.array(z.string().min(1)).min(1).nullable().optional(),
      proposedRepos: z.array(z.string().min(1)).min(1).nullable().optional(),
      alsoRemoveIds: z.array(z.string().regex(/^[RL][1-9]\d*$/)).optional(),
    })
    .refine(
      (val) =>
        val.alsoRemoveIds === undefined ||
        (new Set(val.alsoRemoveIds).size === val.alsoRemoveIds.length &&
          val.alsoRemoveIds.every((id) => id !== val.targetId && id[0] === val.targetId[0])),
      {
        message: 'alsoRemoveIds must be unique, distinct from targetId, and share targetId type prefix',
      },
    ),
  z.object({
    op: z.literal('add'),
    proposedText: z.string().trim().min(1),
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
  z
    .object({
      op: z.literal('update'),
      targetId: z.string().regex(/^[RL][1-9]\d*$/),
      existingRecord: z.union([MemoryRuleRecordSchema, MemoryLessonRecordSchema]),
      whyMatched: z.string().trim().min(1),
      proposedText: z.string().trim().min(1),
      proposedRole: z.string().min(1),
      proposedContext: z.array(z.string().min(1)).min(1).nullable().optional(),
      proposedRepos: z.array(z.string().min(1)).min(1).nullable().optional(),
      alsoRemoveIds: z.array(z.string().regex(/^[RL][1-9]\d*$/)).optional(),
    })
    .refine(
      (val) =>
        val.alsoRemoveIds === undefined ||
        (new Set(val.alsoRemoveIds).size === val.alsoRemoveIds.length &&
          val.alsoRemoveIds.every((id) => id !== val.targetId && id[0] === val.targetId[0])),
      {
        message: 'alsoRemoveIds must be unique, distinct from targetId, and share targetId type prefix',
      },
    ),
  z.object({
    op: z.literal('add'),
    proposedText: z.string().trim().min(1),
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
export const DistillerStructuredOutputSchema = z
  .object({
    matchStatus: z.enum([
      'NO_MATCH',
      'LIKELY_MATCH',
      'EXACT_DUPLICATE',
      'REJECTED_TIER_1_OR_2',
    ]),
    tierRejectionReason: z.string().trim().min(1).optional(),
    recommendedChoiceIndex: z.number().int().min(-1),
    choices: z.array(DistillerChoiceOutputSchema),
  })
  .superRefine((val, ctx) => {
    if (val.matchStatus === 'REJECTED_TIER_1_OR_2') {
      if (val.tierRejectionReason === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['tierRejectionReason'],
          message: 'tierRejectionReason is required when matchStatus is REJECTED_TIER_1_OR_2.',
        });
      }
      if (val.choices.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['choices'],
          message: 'choices must be empty when matchStatus is REJECTED_TIER_1_OR_2.',
        });
      }
    } else if (val.tierRejectionReason !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['tierRejectionReason'],
        message: 'tierRejectionReason is only permitted when matchStatus is REJECTED_TIER_1_OR_2.',
      });
    }
    if (val.matchStatus === 'EXACT_DUPLICATE' && val.choices.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['choices'],
        message: 'choices must be empty when matchStatus is EXACT_DUPLICATE.',
      });
    }
    if (val.matchStatus === 'LIKELY_MATCH' && !val.choices.some((c) => c.op === 'update')) {
      ctx.addIssue({
        code: 'custom',
        path: ['choices'],
        message: 'choices must include at least one op: "update" choice when matchStatus is LIKELY_MATCH.',
      });
    }
    if (val.choices.length === 0 && val.recommendedChoiceIndex !== -1) {
      ctx.addIssue({
        code: 'custom',
        path: ['recommendedChoiceIndex'],
        message: 'recommendedChoiceIndex must be -1 when choices is empty.',
      });
    }
    if (
      val.choices.length > 0 &&
      (val.recommendedChoiceIndex < 0 || val.recommendedChoiceIndex >= val.choices.length)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['recommendedChoiceIndex'],
        message: 'recommendedChoiceIndex must be a valid index into choices.',
      });
    }
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
  rawText: z.string().trim().min(1),
  context: z.array(z.string().min(1)).min(1).optional(),
  repos: z.array(z.string().min(1)).min(1).optional(),
  incident: z.string().trim().min(1).max(1000).optional(),
});

/**
 * Inferred input type for `memory_propose`.
 */
export type MemoryProposeInput = z.infer<typeof MemoryProposeInputSchema>;

/**
 * Output schema for `memory_propose`, discriminated by `executionMode`.
 */
export const MemoryProposeOutputSchema = z
  .discriminatedUnion('executionMode', [
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
      tierRejectionReason: z.string().trim().min(1).optional(),
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
        timeoutMs: z.number().int().min(1000).max(600000),
        systemPrompt: z.string().min(1),
        userPrompt: z.string().min(1),
        outputJsonSchema: z.record(z.string(), z.unknown()),
      }),
    }),
  ])
  .superRefine((val, ctx) => {
    if (val.executionMode !== 'resolved') return;
    if (val.type === 'rule' && val.matchStatus === 'REJECTED_TIER_1_OR_2') {
      ctx.addIssue({
        code: 'custom',
        path: ['matchStatus'],
        message: 'matchStatus cannot be REJECTED_TIER_1_OR_2 when type is "rule".',
      });
    }
    if (val.matchStatus === 'REJECTED_TIER_1_OR_2') {
      if (val.tierRejectionReason === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['tierRejectionReason'],
          message: 'tierRejectionReason is required when matchStatus is REJECTED_TIER_1_OR_2.',
        });
      }
      if (val.choices.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['choices'],
          message: 'choices must be empty when matchStatus is REJECTED_TIER_1_OR_2.',
        });
      }
    } else if (val.tierRejectionReason !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['tierRejectionReason'],
        message: 'tierRejectionReason is only permitted when matchStatus is REJECTED_TIER_1_OR_2.',
      });
    }
    if (val.matchStatus === 'EXACT_DUPLICATE' && val.choices.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['choices'],
        message: 'choices must be empty when matchStatus is EXACT_DUPLICATE.',
      });
    }
    if (val.matchStatus === 'LIKELY_MATCH' && !val.choices.some((c) => c.op === 'update')) {
      ctx.addIssue({
        code: 'custom',
        path: ['choices'],
        message: 'choices must include at least one op: "update" choice when matchStatus is LIKELY_MATCH.',
      });
    }
    if (
      val.matchStatus === 'NO_MATCH' &&
      val.choices.length === 0 &&
      val.bucketStatus.zone !== 'AT_HARD_CAP'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['choices'],
        message: 'choices must not be empty when matchStatus is NO_MATCH unless bucketStatus.zone is AT_HARD_CAP.',
      });
    }
    if (val.choices.length === 0 && val.recommendedChoiceIndex !== -1) {
      ctx.addIssue({
        code: 'custom',
        path: ['recommendedChoiceIndex'],
        message: 'recommendedChoiceIndex must be -1 when choices is empty.',
      });
    }
    if (
      val.choices.length > 0 &&
      (val.recommendedChoiceIndex < 0 || val.recommendedChoiceIndex >= val.choices.length)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['recommendedChoiceIndex'],
        message: 'recommendedChoiceIndex must be a valid index into choices.',
      });
    }
  });

/**
 * Inferred output type for `memory_propose`.
 */
export type MemoryProposeOutput = z.infer<typeof MemoryProposeOutputSchema>;
```

**Behavioral & Validation Contract for `memory_propose`:**
1. Validate `callerRole` and `targetRole` against `config.allowedRoles` (throwing `MemoryHarnessError` with `'INVALID_ROLE'`). Normalize and deduplicate `context` (if provided) via `normalizeMemoryPathPattern` (§4.1).
2. Acquire `<ledgerPath>.lock` (running `ensureMemoryGitCheckout` per §8.2.1 if `config.storage.git.enabled`), load an in-memory snapshot of `memory.jsonl` while excluding any `hard-expiry` notes where `nowMs >= Date.parse(expiresAt)`, compute `bucketStatus` (including `bucketStatus.bucketRecordIds`) for a synthetic candidate `{ type: input.type, role: input.targetRole, context: normalizedContext, repos: input.repos }` using §5.2, and immediately release `<ledgerPath>.lock` so `<ledgerPath>.lock` is never held during prompt construction or Distiller execution across Steps 3 and 4.
3. Build the **Prompt-Cached Distiller Prompt**:
   - **`systemPrompt` (static prefix for KV-caching):** Contains the Distiller instructions, `config.format` rules, `config.distiller.customInstructions`, the current repository's role rule files (`CLAUDE.MD`, plus `docs/rules/*.md` when present sorted in ascending POSIX path code-unit order), and all active `R*` and `L*` records in the in-memory `memory.jsonl` snapshot applicable to `config.repoId` (§5.1) in §3.1 canonical order (`R1, R2, ...` then `L1, L2, ...`).
   - **`userPrompt` (dynamic suffix):** Contains the candidate `{ type, targetRole, rawText, normalizedContext, repos, incident }`, the target `bucketStatus` (`bucketId`, `zone`, `currentCount`, `softCap`, `hardCap`, `bucketRecordIds`, `totalRecordsCount`, `maxTotalRecords`, `maxTotalRecordsReached`), the choice-scope contract (`op: 'add'` preserves the candidate's target `role`, `context`, and `repos`, while `op: 'update'` must match `input.type` and may widen scope via `null` for unscoped `proposedContext` or all-repos `proposedRepos`), and the strict rule that in `SOFT_CAP_PRESSURE` or `AT_HARD_CAP`, `capMerge` may be proposed **only** if two existing records in `bucketStatus.bucketRecordIds` with the same `type` and `role` (`keepRecord.type === removeRecord.type && keepRecord.role === removeRecord.role`) share the exact same underlying failure mechanism.
4. **Runner Dispatch (`config.distiller.runner`):**
   - Convert `DistillerStructuredOutputSchema` via `z.toJSONSchema(DistillerStructuredOutputSchema)` into `outputJsonSchema`.
   - If `config.distiller.runner === 'claude-cli'` or if `options.distillerRunner !== undefined`:
     - Invoke `options.distillerRunner.runDistillerProposal(...)` when injected; otherwise (when `config.distiller.runner === 'claude-cli'` and `options.distillerRunner` is omitted), execute the built-in CLI runner spawning `claude -p --model <config.distiller.model> --effort <config.distiller.effort> --system-prompt <systemPrompt> --output-format json --json-schema <JSON.stringify(outputJsonSchema)> <userPrompt>` with timeout `config.distiller.timeoutMs`.
     - If the runner throws, times out, exits non-zero, returns output that fails `DistillerStructuredOutputSchema`, returns `matchStatus === 'REJECTED_TIER_1_OR_2'` when `input.type === 'rule'`, or returns `matchStatus === 'NO_MATCH' && choices.length === 0` when `bucketStatus.zone !== 'AT_HARD_CAP'`, throw `MemoryHarnessError` with code `'DISTILLER_EXECUTION_FAILED'`.
     - Hydrate `existingRecord` from the in-memory `memory.jsonl` snapshot for every `op: 'update'` choice and deterministically validate every choice in `choices`:
       - **Rule Protection & Type Consistency Check:** Require every choice's `targetId`, `alsoRemoveIds`, and `capMerge` (`keepId`, `removeId`) IDs to match `input.type` (`'R'` for `'rule'`, `'L'` for `'lesson'`). If `input.type === 'lesson'` and any choice's `targetId`, `alsoRemoveIds`, or `capMerge` references an `R*` rule record, throw `MemoryHarnessError` (`'RULE_PROTECTION_VIOLATION'`). If `input.type === 'rule'` and any choice references an `L*` record, throw `MemoryHarnessError` (`'DISTILLER_EXECUTION_FAILED'`).
       - Validate `config.allowedRoles.includes(choice.proposedRole)` and normalize+deduplicate `choice.proposedContext` (if an array is present) via `normalizeMemoryPathPattern` (throwing `MemoryHarnessError` with `'DISTILLER_EXECUTION_FAILED'` if invalid).
       - For `choice.op === 'add'`: verify `choice.proposedRole === input.targetRole`, normalized `choice.proposedContext` equals `normalizedContext`, and deduplicated `choice.proposedRepos` equals deduplicated `input.repos` (throwing `MemoryHarnessError` with `'DISTILLER_EXECUTION_FAILED'` otherwise).
       - For `choice.op === 'update'`: verify `choice.targetId` and `choice.alsoRemoveIds` (if present, unique and distinct from `choice.targetId`) exist in active `memory.jsonl` records applicable to `config.repoId` (§5.1), and verify that after removing `choice.alsoRemoveIds`, any bucket or repo-scope transition does not exceed destination `B_new.hardCap` or `config.maxTotalRecords` (throwing `MemoryHarnessError` with `'DISTILLER_EXECUTION_FAILED'` otherwise).
       - For `choice.op === 'add'` with `choice.capMerge !== undefined`: verify `bucketStatus.zone === 'SOFT_CAP_PRESSURE' || bucketStatus.zone === 'AT_HARD_CAP'` (forbidding `capMerge` when `bucketStatus.zone` is `'UNCAPPED'` or `'UNDER_SOFT_CAP'`) and verify that `capMerge.keepId` and `capMerge.removeId` are distinct IDs currently residing in `bucketStatus.bucketRecordIds` whose records satisfy `keepRecord.type === removeRecord.type` and `keepRecord.role === removeRecord.role` (throwing `MemoryHarnessError` with `'DISTILLER_EXECUTION_FAILED'` otherwise).
       - If `input.type === 'lesson'`, verify that every `choice.proposedText` (and any `choice.capMerge.mergedText`) passes `validateLessonTextFormat(text, config.format)` (§6.7).
     - Return `executionMode: 'resolved'` with `requiresOwnerGo: input.type === 'rule'`.
   - If `config.distiller.runner === 'subagent'` and `options.distillerRunner === undefined` (standalone MCP stdio server mode):
     - Return `executionMode: 'delegate_to_subagent'` with `requiresOwnerGo: input.type === 'rule'` and `delegateToSubagent: { model: config.distiller.model, effort: config.distiller.effort, timeoutMs: config.distiller.timeoutMs, systemPrompt, userPrompt, outputJsonSchema }` so the calling agent invokes its native subagent tool and passes the selected choice to `memory_commit`.

---

### 6.5 Tool 4: `memory_commit`

Atomically adds, updates, or removes a record in `memory.jsonl`.

```ts
/**
 * Input schema for `memory_commit`, discriminated by `op` (`'add' | 'update' | 'remove'`).
 */
export const MemoryCommitInputSchema = z
  .discriminatedUnion('op', [
    z.object({
      op: z.literal('add'),
      callerRole: z.string().min(1),
      type: MemoryRecordTypeSchema,
      role: z.string().min(1),
      text: z.string().trim().min(1),
      context: z.array(z.string().min(1)).min(1).optional(),
      repos: z.array(z.string().min(1)).min(1).optional(),
      lifecycle: NoteLifecycleSchema.optional(),
      capMerge: z
        .object({
          keepId: z.string().regex(/^[RLN][1-9]\d*$/),
          removeId: z.string().regex(/^[RLN][1-9]\d*$/),
          mergedText: z.string().trim().min(1),
        })
        .optional(),
    }),
    z.object({
      op: z.literal('update'),
      callerRole: z.string().min(1),
      id: z.string().regex(/^[RLN][1-9]\d*$/),
      text: z.string().trim().min(1),
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
  ])
  .superRefine((val, ctx) => {
    if (val.op === 'add') {
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
    }
    if (val.op === 'update') {
      if (val.lifecycle !== undefined && !val.id.startsWith('N')) {
        ctx.addIssue({
          code: 'custom',
          path: ['lifecycle'],
          message: 'lifecycle is only permitted when updating a note record (ID starting with "N").',
        });
      }
      if (val.alsoRemoveIds !== undefined) {
        const seen = new Set<string>();
        const targetPrefix = val.id[0];
        for (let i = 0; i < val.alsoRemoveIds.length; i += 1) {
          const remId = val.alsoRemoveIds[i];
          if (remId === undefined) continue;
          if (remId === val.id || seen.has(remId)) {
            ctx.addIssue({
              code: 'custom',
              path: ['alsoRemoveIds', i],
              message: 'alsoRemoveIds must contain unique IDs distinct from target id.',
            });
          }
          seen.add(remId);
          if (targetPrefix !== undefined && !remId.startsWith(targetPrefix)) {
            ctx.addIssue({
              code: 'custom',
              path: ['alsoRemoveIds', i],
              message: `alsoRemoveIds entry '${remId}' must match target record prefix '${targetPrefix}'.`,
            });
          }
        }
      }
    }
  });

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
1. Validate `callerRole` (and `role` if present) against `config.allowedRoles` (throwing `'INVALID_ROLE'`). Normalize and deduplicate any `context` array via `normalizeMemoryPathPattern` (§4.1). Trim `input.text` (and `input.capMerge.mergedText` if present).
2. **Pre-Lock Format & Rule Protection Gate:**
   - If `op === 'add' && input.type !== 'rule' && input.capMerge !== undefined` and (`input.capMerge.keepId.startsWith('R') || input.capMerge.removeId.startsWith('R')`), throw `MemoryHarnessError` (`'RULE_PROTECTION_VIOLATION'`).
   - If `op === 'update'` and `!input.id.startsWith('R')` and any ID in `input.alsoRemoveIds` starts with `'R'`, throw `MemoryHarnessError` (`'RULE_PROTECTION_VIOLATION'`).
   - Validate remaining input fields against `MemoryCommitInputSchema` (throwing `'VALIDATION_FAILED'` on schema issues).
   - If `op === 'add' && type === 'lesson'`, validate `input.text.trim()` against `config.format` via `validateLessonTextFormat` (§6.7).
   - If `op === 'add' && type === 'lesson' && input.capMerge !== undefined`, validate `input.capMerge.mergedText.trim()` against `config.format`.
   - If `op === 'update' && input.id.startsWith('L')`, validate `input.text.trim()` against `config.format`.
3. Acquire `<ledgerPath>.lock` via `withFileLock`:
   - If `config.storage.git.enabled === true`, ensure the Git storage checkout is initialized per §8.2.1.
   - Load `memory.jsonl` and `memory.meta.json`, immediately reconcile `meta.highWaterMarks` across all raw loaded records per §3.1 before any purge, and purge any `hard-expiry` notes with `nowMs >= Date.parse(expiresAt)`.
   - **On `op === 'add'`:**
     - Evaluate the target bucket `B` and `bucketStatus` (§5.2–§5.3).
     - If `input.capMerge` is provided:
       - Verify `bucketStatus.zone === 'SOFT_CAP_PRESSURE' || bucketStatus.zone === 'AT_HARD_CAP'` (throwing `'VALIDATION_FAILED'` if `zone` is `'UNCAPPED'` or `'UNDER_SOFT_CAP'`).
       - Locate `keepRecord` (`keepId`) and `removeRecord` (`removeId`) in active `memory.jsonl` records applicable to `config.repoId` (§5.1); if either is absent, throw `MemoryHarnessError` (`'RECORD_NOT_FOUND'`).
       - Verify both `keepId` and `removeId` exist in bucket `B` (`bucketStatus.bucketRecordIds`), have `keepRecord.type === input.type && removeRecord.type === input.type`, and share the same role (`keepRecord.role === removeRecord.role`) (throwing `'VALIDATION_FAILED'` if any check fails).
       - Update `keepId` with `text: input.capMerge.mergedText.trim()`, `updatedAt: nowIso`, `context` set to the deduplicated union of `keepId.context` and `removeId.context` when both are defined (or `undefined` if either is unscoped), and `repos` set to the deduplicated union of `keepId.repos` and `removeId.repos` when both are defined (or `undefined` if either applies to all repos), and delete `removeId`.
     - Check capacity after applying any `capMerge`: if the added record applies to `config.repoId` and `(hardCap !== null && nextBucketCount > hardCap)` or `(config.maxTotalRecords !== undefined && nextTotalCount > config.maxTotalRecords)`, throw `MemoryHarnessError` (`'CAP_EXCEEDED'`) without modifying disk.
     - Allocate the next monotonic ID (`R<n>`, `L<n>`, or `N<n>`) per §3.1, construct the new `MemoryRecord` with `text: input.text.trim()` and `createdAt: nowIso`, insert in canonical order, and write `memory.meta.json` first and `memory.jsonl` second atomically per §8.1 Rule 2.
   - **On `op === 'update'`:**
     - Locate existing record `target` with `target.id === input.id` in `memory.jsonl`; if absent, throw `MemoryHarnessError` (`'RECORD_NOT_FOUND'`).
     - If `input.lifecycle !== undefined && target.type !== 'note'`, throw `MemoryHarnessError` (`'VALIDATION_FAILED'`).
     - If `input.alsoRemoveIds` is provided:
       - **Rule Protection Check:** If `target.type !== 'rule'` and any ID in `alsoRemoveIds` starts with `'R'`, throw `MemoryHarnessError` (`'RULE_PROTECTION_VIOLATION'`).
       - Verify all IDs in `alsoRemoveIds` exist in `memory.jsonl` (throwing `'RECORD_NOT_FOUND'` if absent), and verify all IDs in `alsoRemoveIds` are unique, distinct from `input.id`, have `type === target.type`, and are applicable to `config.repoId` (§5.1) (throwing `'VALIDATION_FAILED'` if invalid).
       - Remove all records in `alsoRemoveIds`.
     - Compute the updated record (`text: input.text.trim()`, `role: input.role ?? target.role`, `context: input.context === null ? undefined : (normalizedInputContext ?? target.context)`, `repos: input.repos === null ? undefined : (input.repos ?? target.repos)`, `lifecycle: input.lifecycle ?? target.lifecycle`, `updatedAt: nowIso`).
     - **Capacity Check on Bucket or Repo-Scope Transition:** After removing `alsoRemoveIds`, if the updated record applies to `config.repoId` (§5.1) and was not already an active member of `B_new` for `config.repoId` (either because its `bucketId` changed or because `target` did not previously apply to `config.repoId`), verify `B_new` does not exceed `B_new.hardCap` and total active records for `config.repoId` do not exceed `config.maxTotalRecords` (throwing `MemoryHarnessError` with `'CAP_EXCEEDED'` without modifying disk).
     - Persist `memory.meta.json` (if created or `highWaterMarks` advanced) first and `memory.jsonl` second atomically.
   - **On `op === 'remove'`:**
     - Locate existing record `target` with `target.id === input.id`; if absent, throw `MemoryHarnessError` (`'RECORD_NOT_FOUND'`).
     - **Rule Protection & Reason Validation:**
       - If `target.type === 'rule'` and `input.reason !== 'owner_veto'`, throw `MemoryHarnessError` (`'RULE_PROTECTION_VIOLATION'`).
       - If `input.reason === 'note_settled_or_obsolete'` and `target.type !== 'note'`, or if `target.type === 'note'` and `(input.reason === 'promoted_to_tier1_or_tier2' || input.reason === 'merged_into_wider_record')`, throw `MemoryHarnessError` (`'VALIDATION_FAILED'`).
     - Remove `target` from `memory.jsonl`, leaving `memory.meta.json` `highWaterMarks` untouched so `input.id` is never reused. Persist `memory.meta.json` (if created or `highWaterMarks` advanced) first and `memory.jsonl` second atomically.
   - Run the Git auto-commit/push step (§8.2) while holding `<ledgerPath>.lock`.
4. **Output Field Mapping (`MemoryCommitOutput`):**
   - **`op === 'add'`:** `committedRecord` = newly added record (with re-numbered `id` if §8.2.3 remapped it during push reconcile), `previousRecord = null`, `mergedKeepRecord` = updated `keepId` record if `capMerge` was applied else `null`, `removedIds = input.capMerge ? [input.capMerge.removeId] : []`, `bucketStatusAfter` = post-commit `MemoryBucketStatus` of `committedRecord`'s bucket (or `null` if `committedRecord` does not apply to `config.repoId`).
   - **`op === 'update'`:** `committedRecord` = updated record, `previousRecord` = snapshot of `target` prior to update, `mergedKeepRecord = null`, `removedIds = input.alsoRemoveIds ?? []`, `bucketStatusAfter` = post-commit `MemoryBucketStatus` of `committedRecord`'s bucket (or `null` if `committedRecord` does not apply to `config.repoId`).
   - **`op === 'remove'`:** `committedRecord = null`, `previousRecord` = removed `target` record, `mergedKeepRecord = null`, `removedIds = [input.id]`, `bucketStatusAfter` = post-commit `MemoryBucketStatus` of `previousRecord`'s bucket (or `null` if `previousRecord` did not apply to `config.repoId`).

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
1. Validate `callerRole` (and `input.role` if provided) against `config.allowedRoles` (throwing `'INVALID_ROLE'`). Normalize and deduplicate `input.paths` (if provided) via `normalizeMemoryPathPattern` (§4.1).
2. Acquire `<ledgerPath>.lock`:
   - If `config.storage.git.enabled === true`, ensure the Git storage checkout is initialized per §8.2.1.
   - Load `memory.jsonl` and `memory.meta.json`, immediately reconcile `meta.highWaterMarks` across all raw loaded records per §3.1 before any purge, and exclude any `hard-expiry` notes where `nowMs >= Date.parse(expiresAt)` (purging them on write when `dryRun === false`).
   - Filter all active `type: 'note'` records applicable to `config.repoId` (§5.1) that satisfy **all** specified filters:
     - **Lifecycle mode filter:** `input.modes.includes('*') || input.modes.includes(note.lifecycle.mode)`.
     - **Role filter:** `input.role === undefined || note.role === input.role`.
     - **Path filter:** `input.paths === undefined || (note.context !== undefined && matchesContextScope(normalizedPaths, note.context, repoFiles))`.
     - **ID filter:** `input.ids === undefined || input.ids.includes(note.id)`.
   - If `input.dryRun === true`: return `{ dryRun: true, matchedNotes, drainedIds: [], gitCommitted: false, gitPushed: false }` without mutating `memory.jsonl`.
   - If `input.dryRun === false`: remove `matchedNotes` (and any expired `hard-expiry` notes) from `memory.jsonl`, persist `memory.meta.json` (if created or `highWaterMarks` advanced) first and `memory.jsonl` second atomically per §8.1 Rule 2, execute Git auto-commit/push if configured (§8.2), and return `{ dryRun: false, matchedNotes, drainedIds: matchedNotes.map((n) => n.id), gitCommitted, gitPushed }`.

---

### 6.7 Deterministic Lesson Format Validation (`validateLessonTextFormat`)

Every `type: 'lesson'` text (`trimmed = rawText.trim()`) must pass all five deterministic checks before `memory_propose` (in `resolved` mode) or `memory_commit` accepts it:
1. **Length Bound:** `trimmed.length > 0 && trimmed.length <= config.format.maxChars`.
2. **Single-Sentence Check (when `config.format.requireSingleSentence === true`):**
   - Must not contain newline characters (`\n` or `\r`).
   - Must end with `.`.
   - Must not contain sentence-splitting punctuation followed by whitespace anywhere before the final character (`!/[.!?]\s+/u.test(trimmed.slice(0, -1))`).
3. **Required Substrings:** For every substring `sub` in `config.format.requireSubstrings`, `trimmed.includes(sub)` must be `true`. For `' because '`, split at the first occurrence `const idx = trimmed.indexOf(' because ')` and verify both the action clause before `' because '` (`trimmed.slice(0, idx).trim().length >= 10`) and the mechanism clause after `' because '` excluding the trailing period (`trimmed.slice(idx + ' because '.length, -1).trim().length >= 10`) are at least 10 characters long.
4. **Forbidden Regexes:** Test `trimmed` against the pre-compiled `RegExp` instances compiled at config load time (§2.1 Step 5, `CODING_GUIDELINES.md` Rule 4.4) for `config.format.forbidRegexes`; every `regex.test(trimmed)` must evaluate to `false`.
5. If any check fails, throw `MemoryHarnessError` with code `'LESSON_FORMAT_INVALID'` naming the exact failed check and quoting the offending substring or match.

---

## 7. Just-In-Time File-Interaction Hook & Compaction-Epoch Deduplication

### 7.1 Hook Input/Output Schemas & Trigger Surfaces

The File-Interaction Hook automatically surfaces context-scoped rules, lessons, and active notes on the **first** interaction with a matching file, directory, or glob after session start or after the latest context compaction:

```ts
/**
 * Normalized input payload passed to `MemoryHarness.handleFileInteractionHook`.
 */
export const FileInteractionHookInputSchema = z.object({
  sessionId: SessionIdSchema,
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
   - Extracts candidate paths/globs per tool:
     - `Read`, `Edit`, `MultiEdit`, `Write`: extracts `tool_input.file_path` (plus `tool_input.path` and `tool_input.paths` if present).
     - `NotebookEdit`: extracts `tool_input.notebook_path` (plus `tool_input.file_path` if present).
     - `Glob`: when both `tool_input.path` and `tool_input.pattern` are present, joins the raw strings (`rawPath.replace(/\/+$/, '') + '/' + rawPattern.replace(/^\/+/, '')`) before calling `normalizeMemoryPathPattern`; otherwise extracts `tool_input.pattern` or `tool_input.path`.
     - `Grep`: when `tool_input.glob` is present (non-empty string), extracts **only** the joined raw `(tool_input.path ?? '.').replace(/\/+$/, '') + '/' + tool_input.glob.replace(/^\/+/, '')` before calling `normalizeMemoryPathPattern`; extracts `tool_input.path ?? '.'` only when `tool_input.glob` is omitted or empty (**never** extracting `tool_input.pattern`, which is a regular expression search string rather than a file path).
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
   - Under `.memory/.session-state/<sessionId>.lock` (§7.2), incrementally inspects the latest tool invocation steps in `transcript.jsonl` starting from `state.lastScannedTranscriptOffset` (or from byte offset `0` on initial/reset scan per §7.2 Step 1) across Antigravity file and search tools (`view_file`, `view_file_outline`, `view_code_item`, `replace_file_content`, `multi_replace_file_content`, `write_to_file`, `read_file`, `edit_file`, `write_file`, `grep_search`, `find_by_name`), extracting path and glob arguments (`AbsolutePath`, `File`, `TargetFile`, `Paths`, `path`, `file_path` for file tools; for `find_by_name`, when `Pattern` is a non-empty string, joining raw `(SearchDirectory ?? DirectoryPath ?? '.').replace(/\/+$/, '') + '/' + Pattern.replace(/^\/+/, '')` before calling `normalizeMemoryPathPattern`, or extracting `SearchDirectory ?? DirectoryPath ?? '.'` only when `Pattern` is omitted/empty; for `grep_search`, when `Includes` is a non-empty array or string, joining raw `(SearchPath ?? SearchDirectory ?? '.').replace(/\/+$/, '') + '/' + includePattern.replace(/^\/+/, '')` for each pattern in `Includes` before calling `normalizeMemoryPathPattern`, or extracting `SearchPath ?? SearchDirectory ?? '.'` only when `Includes` is omitted/empty and **never** extracting `Query`), advancing `state.lastScannedTranscriptOffset` to the current transcript byte length, and returning `{ "injectSteps": [{ "systemMessage": { "systemMessage": "<output.formattedContext>" } }] }` when `output.injected === true`.

---

### 7.2 Compaction-Epoch State Schema & Deduplication Algorithm

```ts
/**
 * Fallback active session role persisted at `.memory/.session-state/latest-role.json`.
 */
export const MemoryLatestRoleStateSchema = z.object({
  role: z.string().min(1),
  updatedAt: z.iso.datetime(),
});

/**
 * Inferred fallback latest-role state type.
 */
export type MemoryLatestRoleState = z.infer<typeof MemoryLatestRoleStateSchema>;

/**
 * Per-session deduplication state persisted at `.memory/.session-state/<sessionId>.json`.
 */
export const MemorySessionEpochStateSchema = z.object({
  sessionId: SessionIdSchema,
  role: z.string().min(1),
  lastCompactionCheckpointId: z.string().min(1),
  seenRecordIds: z.array(z.string().regex(/^[RLN][1-9]\d*$/)).default([]),
  lastScannedTranscriptOffset: z.number().int().min(0).default(0),
  transcriptPath: z.string().min(1).optional(),
  updatedAt: z.iso.datetime(),
});

/**
 * Inferred per-session compaction-epoch deduplication state type.
 */
export type MemorySessionEpochState = z.infer<typeof MemorySessionEpochStateSchema>;
```

**Deduplication & Epoch Reset Algorithm:**
1. **Validate Role Input, Acquire Session Lock & Scan Transcript (`resolveTranscriptEpochAndRole`):**
   - If `input.role` is provided, validate `config.allowedRoles.includes(input.role)` (throwing `MemoryHarnessError` with `'INVALID_ROLE'` if invalid).
   - Acquire `.memory/.session-state/<sessionId>.lock` **first** via `withFileLock` (§8.1 Rule 1) and load `.memory/.session-state/<sessionId>.json` (if present) before scanning `transcriptPath`.
   - When `transcriptPath` is provided and readable (with current byte length `transcriptByteLength`):
     - If `<sessionId>.json` does not exist, `state.lastCompactionCheckpointId === 'PENDING_HOOK_EPOCH'`, `state.transcriptPath !== input.transcriptPath`, or `transcriptByteLength < state.lastScannedTranscriptOffset`, scan `transcriptPath` from byte offset `0` (setting `currentCheckpointId` to the last compaction boundary ID found—where a compaction boundary is `obj.type === 'CHECKPOINT'` in Antigravity transcripts or `obj.type === 'compact_boundary' || obj.subtype === 'compact_boundary'` in Claude Code transcripts, with stable identifier `String(obj.step_index ?? obj.uuid ?? obj.timestamp ?? obj.created_at ?? 'offset:' + lineByteOffset)`—or `'epoch-0'` if none exists); otherwise scan incrementally from `state.lastScannedTranscriptOffset` to `transcriptByteLength` (setting `currentCheckpointId` to the latest compaction boundary ID in that slice if found, or retaining `state.lastCompactionCheckpointId` when no new compaction boundary occurred in that slice).
     - Also extract the latest `memory_init` tool call `role` argument found in `transcriptPath` (or the scanned slice).
   - When `transcriptPath` is omitted or unreadable, set `currentCheckpointId` to `(state !== undefined && state.lastCompactionCheckpointId !== 'PENDING_HOOK_EPOCH') ? state.lastCompactionCheckpointId : 'epoch-0'`.
   - If `input.role` was omitted, resolve `resolvedRole` from the first valid role in `config.allowedRoles` across: (a) the latest `memory_init` tool call `role` found in `transcriptPath` (or the scanned slice), (b) `state.role` in `<sessionId>.json` when `state.role !== 'general'`, (c) `.memory/.session-state/latest-role.json`, (d) `state.role` in `<sessionId>.json`, or (e) final fallback `'general'`.
2. **Initialize or Reset Session State Under Lock (§8.1 Rule 1):**
   - If `<sessionId>.json` exists and `state.lastCompactionCheckpointId === 'PENDING_HOOK_EPOCH'`, set `state.lastCompactionCheckpointId = currentCheckpointId` **without** clearing `state.seenRecordIds` (preserving any scoped record IDs already loaded via `memory_load_scoped` since `memory_init`).
   - Otherwise, if `<sessionId>.json` does not exist or `state.lastCompactionCheckpointId !== currentCheckpointId`, set `state.lastCompactionCheckpointId = currentCheckpointId` and reset `state.seenRecordIds = []`.
   - Update `state.role = resolvedRole`, `state.transcriptPath = input.transcriptPath ?? state.transcriptPath`, `state.lastScannedTranscriptOffset = transcriptByteLength` (when `transcriptPath` was scanned), and `state.updatedAt = nowIso`.
3. **Normalize `touchedPaths` & Early-Exit on Out-of-Workspace Paths:**
   - Normalize and deduplicate `input.touchedPaths` via `normalizeMemoryPathPattern` (§4.1), catching `MemoryHarnessError` (`'VALIDATION_FAILED'`) on out-of-workspace entries to skip them.
   - If zero valid in-workspace `touchedPaths` remain, atomically persist `.memory/.session-state/<sessionId>.json` (whenever Step 2 created or modified the session state), release `.memory/.session-state/<sessionId>.lock`, and return `{ injected: false, compactionEpochId: currentCheckpointId, formattedContext: null, rules: [], lessons: [], notes: [] }` without acquiring `<ledgerPath>.lock`.
4. **Match & Filter Unseen Scoped Records Under `<ledgerPath>.lock`:**
   - While holding `.memory/.session-state/<sessionId>.lock`, acquire `<ledgerPath>.lock` **second** per §8.1 Rule 1:
     - If `config.storage.git.enabled === true`, ensure the Git storage checkout is initialized per §8.2.1.
     - Load `memory.jsonl` and `memory.meta.json`, immediately reconcile `meta.highWaterMarks` across all raw loaded records per §3.1 before any purge, and purge any expired `hard-expiry` notes (`nowMs >= Date.parse(expiresAt)`).
     - Query scoped records (`record.context !== undefined && record.context.length > 0`) for `(record.role === 'general' || record.role === resolvedRole)` and `config.repoId` (§5.1) where `matchesContextScope(touchedPaths, record.context, repoFiles)` is `true`, and filter to records whose `id` is **not** in `new Set(state.seenRecordIds)`.
     - Apply §3.3 lifecycle transitions (`read-count` and `soft-expiry`) to only the newly matched unseen `N*` notes.
     - Follow the §8.1 Rule 2 multi-file write order: atomically write `memory.meta.json` first (whenever created or `highWaterMarks` advanced), atomically write `memory.jsonl` second (whenever any note was purged, decremented, or drained), and run §8.2 Git auto-commit/push third (when `config.storage.git.enabled && config.storage.git.autoCommit` and `memory.jsonl` or `memory.meta.json` was written).
   - Append all newly injected `R*`, `L*`, and `N*` IDs (deduplicated) to `state.seenRecordIds`, and atomically write `.memory/.session-state/<sessionId>.json` fourth whenever Step 2 or Step 4 created or modified the session state (even if 0 unseen scoped records matched).
   - If the filtered unseen record list is empty, return `{ injected: false, compactionEpochId: currentCheckpointId, formattedContext: null, rules: [], lessons: [], notes: [] }`; otherwise return `injected: true` with `formattedContext`, `rules`, `lessons`, and `notes` ordered per §1.2.

---

## 8. Concurrency, Locking & Multi-Repo Git Synchronization

### 8.1 Lock Ordering & Atomic Persistence Invariants

1. **Lock Acquisition Order:** When both a session state lock (`.memory/.session-state/<sessionId>.lock`) and the ledger lock (`<ledgerPath>.lock`) are acquired, always acquire `.memory/.session-state/<sessionId>.lock` **first** and `<ledgerPath>.lock` **second**—never the reverse—so two concurrent hooks or tool calls can never deadlock. (`.memory/.session-state/latest-role.lock` is acquired and released independently before acquiring `<sessionId>.lock` or `<ledgerPath>.lock`; any post-reconcile ID remapping of other sessions' `.memory/.session-state/<otherSid>.json` files is performed strictly **after** releasing `<ledgerPath>.lock` and `<sessionId>.lock`, acquiring each `.memory/.session-state/<otherSid>.lock` individually via `withFileLock`.)
2. **Atomic Write Requirement & Strict Multi-File Write Ordering:** Every write to `memory.meta.json`, `memory.jsonl`, `.memory/.session-state/<sessionId>.json`, and `.memory/.session-state/latest-role.json` uses `write-file-atomic` (temp file in target directory + `fsync` + POSIX `rename`) inside `@paraharness/lockfile`'s `withFileLock`. Every operation holding `<ledgerPath>.lock` immediately reconciles `meta.highWaterMarks[P] = Math.max(meta.highWaterMarks[P], maxNumericIdInLedger(rawLoadedRecords, P))` across all raw records in `memory.jsonl` **before** purging expired `hard-expiry` notes or removing records, and enforces the strict write sequence:
   1. `memory.meta.json` (whenever created or `highWaterMarks` advance),
   2. `memory.jsonl` (whenever records are added, updated, purged, decremented, or drained),
   3. §8.2 Git auto-commit/push (when `config.storage.git.enabled && config.storage.git.autoCommit` and `memory.meta.json` or `memory.jsonl` was written), and
   4. `.memory/.session-state/<sessionId>.json` (whenever session state was created or updated, after applying any §8.2.3 `cumulativeIdRemap` to the caller's in-memory `state.seenRecordIds` and active return payload).
3. **Gitignored Ephemeral Files:** `.memory/*.lock`, `.memory/.session-state/`, and any `write-file-atomic` temporary files (`*.tmp*`) MUST be excluded in `<checkoutDir>/.gitignore` so ephemeral lock and session files are never committed to the memory Git repository.

---

### 8.2 Git Checkout Initialization, Auto-Commit & 3-Way Conflict-Free Reconcile (`config.storage.git`)

When `config.storage.git.enabled === true`:
1. **Checkout Initialization (`ensureMemoryGitCheckout`):**
   - Executed inside `<ledgerPath>.lock` prior to ledger reads or writes.
   - Resolve `checkoutDir = path.resolve(workspaceRoot, config.storage.git.checkoutDir)` and ensure `<checkoutDir>` exists (`fs.mkdir(checkoutDir, { recursive: true })`).
   - If `<checkoutDir>/.git` does not exist (initializing in-place so pre-existing `.session-state/` or `*.lock` files inside `<checkoutDir>` never cause `git clone` to fail on a non-empty directory):
     - Run `git init -b <branch> <checkoutDir>`.
     - Ensure `<checkoutDir>/.gitignore` contains `.session-state/`, `*.lock`, and `*.tmp*`.
     - If `config.storage.git.remoteUrl !== undefined`:
       - Configure `origin` (`git -C <checkoutDir> remote add origin <remoteUrl>`, or `git -C <checkoutDir> remote set-url origin <remoteUrl>` if `origin` already exists).
       - Run `git -C <checkoutDir> ls-remote --heads origin refs/heads/<branch>` (throwing `MemoryHarnessError` with `'GIT_SYNC_FAILED'` if `ls-remote` exits non-zero due to network or authentication failure).
       - If `refs/heads/<branch>` exists on `origin`: run `git -C <checkoutDir> fetch origin <branch>`. If a local `<relLedgerPath>` already existed on disk prior to fetch, snapshot its local records/meta, run `git -C <checkoutDir> reset --hard origin/<branch>`, ensure `<checkoutDir>/.gitignore` contains `.session-state/`, `*.lock`, and `*.tmp*`, reconcile the pre-existing local records with `origin/<branch>` via `reconcileDivergedMemoryLedgers(emptyBase, local, remote)` (§8.2.3), atomically write `mergedMeta` first and `mergedRecords` second to disk via `write-file-atomic`, and if `config.storage.git.autoCommit === true`, stage and commit (and push if `config.storage.git.autoPush === true`) per §8.2.2–§8.2.3; otherwise run `git -C <checkoutDir> reset --hard origin/<branch>`.
     - Ensure `<checkoutDir>/.gitignore` contains `.session-state/`, `*.lock`, and `*.tmp*` after the `if (config.storage.git.remoteUrl !== undefined)` block so `git reset --hard origin/<branch>` never leaves `.gitignore` missing those entries.
   - Whenever `<checkoutDir>/.git` already exists:
     - Ensure `<checkoutDir>/.gitignore` contains `.session-state/`, `*.lock`, and `*.tmp*`.
     - When invoked by `memory_init` (§6.2) with `config.storage.git.autoPullOnInit === true && config.storage.git.remoteUrl !== undefined`, run a best-effort `git -C <checkoutDir> fetch origin <branch>` (if `git fetch` exits non-zero due to transient offline or network unavailability during `memory_init`, continue with the local ledger rather than throwing `'GIT_SYNC_FAILED'`). If `git fetch` succeeds and `origin/<branch>` exists and is not already an ancestor of `HEAD` (`git -C <checkoutDir> merge-base --is-ancestor origin/<branch> HEAD` exits non-zero), reconcile `HEAD` (`local`) and `origin/<branch>` (`remote`) relative to `merge-base HEAD origin/<branch>` (`base`) via `reconcileDivergedMemoryLedgers(base, local, remote)` (§8.2.3), run `git -C <checkoutDir> reset --hard origin/<branch>`, ensure `<checkoutDir>/.gitignore` contains `.session-state/`, `*.lock`, and `*.tmp*`, atomically write `mergedMeta` first and `mergedRecords` second via `write-file-atomic`, and if `config.storage.git.autoCommit === true`, stage and commit (and push if `config.storage.git.autoPush === true`) per §8.2.2–§8.2.3.
2. **Auto-Commit (`config.storage.git.autoCommit === true`):**
   - Inside `<ledgerPath>.lock`, after writing `memory.meta.json` and `memory.jsonl`:
   - Stage only the ledger, metadata, and ignore files: `git -C <checkoutDir> add -- <relLedgerPath> <relMetaPath> .gitignore`.
   - Check `git -C <checkoutDir> status --porcelain -- <relLedgerPath> <relMetaPath> .gitignore`. If non-empty, commit with fallback author identity `git -C <checkoutDir> -c user.name="paraharness-memory" -c user.email="memory@paraharness.local" commit -m "memory(<repoId>): <opSummary>"`.
3. **Conflict-Free Multi-Repo Auto-Push (`config.storage.git.autoPush === true` and `remoteUrl` configured):**
   - Run `git -C <checkoutDir> push origin <branch>`.
   - If `git push` exits non-zero due to non-fast-forward remote updates (another repository or session pushed new memory records concurrently):
     1. Run `git -C <checkoutDir> fetch origin <branch>` and resolve `baseSha = git -C <checkoutDir> merge-base HEAD origin/<branch>`. If `git merge-base` exits with code `1` (unrelated histories) or if `<relLedgerPath>` / `<relMetaPath>` is absent at `<baseSha>`, default `base` to empty (`records: []`, `highWaterMarks: { R: 0, L: 0, N: 0 }`).
     2. Read `base` (`<baseSha>`), `local` (`HEAD`), and `remote` (`origin/<branch>`) versions of `<relLedgerPath>` and `<relMetaPath>` and reconcile them deterministically in-memory via `reconcileDivergedMemoryLedgers(base, local, remote)`:
        - **ID Collision & Monotonic High-Water-Mark Re-numbering:** Any record newly added in `local` (absent in `base`) whose numeric ID `n <= remoteMeta.highWaterMarks[P]` or whose `id` collides with a record in `remote` absent in `base` (unless an identical record with the same `type`, `role`, `text`, and `createdAt` already exists at `id` in `remote`) MUST be re-numbered in ascending numeric ID order to sequential IDs `${P}${nextMonotonicId}` starting above `Math.max(localMeta.highWaterMarks[P], remoteMeta.highWaterMarks[P], maxNumericId(local, P), maxNumericId(remote, P))`, keeping `remote`'s record/allocation at the original ID and recording the mapping in `idRemap: ReadonlyMap<string, string>`.
        - **Three-Way Record Merge:**
          - Compare all record timestamps numerically via `Date.parse(r.updatedAt ?? r.createdAt)`.
          - A record present in `base` and deleted in `local` stays deleted unless `remote` modified it after `base` (`Date.parse(remote.updatedAt ?? remote.createdAt) > Date.parse(base.updatedAt ?? base.createdAt)`).
          - A record present in `base` and deleted in `remote` stays deleted unless `local` modified it after `base` (`Date.parse(local.updatedAt ?? local.createdAt) > Date.parse(base.updatedAt ?? base.createdAt)`).
          - For records present in both `local` and `remote` with the same `id`:
            - For `read-count` notes where both `local` and `remote` have `lifecycle.mode === 'read-count'` and `updatedAt` did not advance past `base`, compute `mergedRemaining = base?.lifecycle.mode === 'read-count' ? base.lifecycle.remainingReads - (base.lifecycle.remainingReads - local.lifecycle.remainingReads) - (base.lifecycle.remainingReads - remote.lifecycle.remainingReads) : Math.min(local.lifecycle.remainingReads, remote.lifecycle.remainingReads)`. If `mergedRemaining <= 0`, delete the note from `mergedRecords`; otherwise retain the note with `remainingReads: mergedRemaining`.
            - Otherwise, if one side is unchanged from `base` and the other side modified it, keep the modified side; if both sides modified it, keep the version with the larger `Date.parse(r.updatedAt ?? r.createdAt)` (breaking exact millisecond ties in favor of `local`).
        - **High-Water-Mark Merge:** For each prefix `P` in `['R', 'L', 'N']`, set `mergedMeta.highWaterMarks[P] = Math.max(localMeta.highWaterMarks[P], remoteMeta.highWaterMarks[P], maxNumericIdInMergedRecords(P))`.
     3. **Post-Reconcile Capacity Check, Atomic Write & State Remapping:**
        - **Post-Reconcile Capacity Check & Pre-Operation Rollback:** Re-evaluate `bucketStatusAfter` on `mergedRecords`. If the local operation was `op: 'add'` or a bucket- or repo-scope-changing `op: 'update'` (§6.5) and `mergedRecords` now exceeds the target bucket's `hardCap` or `config.maxTotalRecords`, restore the pre-operation local ledger/meta snapshot reconciled with `origin/<branch>` (running `git -C <checkoutDir> reset --hard origin/<branch>`, ensuring `<checkoutDir>/.gitignore` contains `.session-state/`, `*.lock`, and `*.tmp*`, writing the reconciled pre-operation `meta` first and `records` second atomically via `write-file-atomic`, and staging/committing if `config.storage.git.autoCommit === true`) before throwing `MemoryHarnessError` (`'CAP_EXCEEDED'`), so prior unpushed local commits are never lost.
        - **Atomic Write, Staging & Clean-Tree Check:** Reset `<checkoutDir>` branch to `origin/<branch>` (`git -C <checkoutDir> reset --hard origin/<branch>`), ensure `<checkoutDir>/.gitignore` contains `.session-state/`, `*.lock`, and `*.tmp*`, write `mergedMeta` first and `mergedRecords` second atomically via `write-file-atomic`, run `git -C <checkoutDir> add -- <relLedgerPath> <relMetaPath> .gitignore`, and check `git -C <checkoutDir> status --porcelain -- <relLedgerPath> <relMetaPath> .gitignore`: only when non-empty, create the reconciled commit with fallback author identity and re-run `git -C <checkoutDir> push origin <branch>` (retrying up to 3 times on concurrent races, throwing `MemoryHarnessError` with `'GIT_SYNC_FAILED'` if still failing; when `git status --porcelain` is empty, `origin/<branch>` already reflects the merged state and no commit or push is needed).
        - **Transitive `cumulativeIdRemap` & Lock-Safe Session State Remapping:** Compose `idRemap` transitively across push retry attempts into `cumulativeIdRemap: Map<string, string>` (`prevOld -> prevNew` updated to `prevOld -> latestIdRemap.get(prevNew) ?? prevNew`, plus any newly remapped IDs). When `cumulativeIdRemap.size > 0`:
          1. Apply `cumulativeIdRemap` in-memory to the active operation's return payload (`MemoryCommitOutput`—also updating `bucketStatusAfter` to the post-reconcile `bucketStatusAfter` evaluated on `mergedRecords`—`MemoryInitOutput`, `MemoryLoadScopedOutput`, `MemoryDrainNotesOutput`, `FileInteractionHookOutput`) and to the caller's own in-memory `state.seenRecordIds` before writing `<sessionId>.json` in Step 4 of the multi-file write order (§8.1 Rule 2).
          2. Remap any other `.memory/.session-state/<otherSid>.json` files **only after releasing `<ledgerPath>.lock` (and `<sessionId>.lock`)**, acquiring each `.memory/.session-state/<otherSid>.lock` individually via `withFileLock` before reading, remapping `seenRecordIds`, and atomically writing `<otherSid>.json` (preserving lock-ordering invariant §8.1 Rule 1 with zero AB-BA deadlock).

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
  /** JSON Schema object generated from `DistillerStructuredOutputSchema` for structured output enforcement. */
  readonly outputJsonSchema: Readonly<Record<string, unknown>>;
}

/**
 * Port interface for executing the Distiller LLM (`claude-cli` or in-process orchestrator subagent).
 */
export interface MemoryDistillerRunner {
  /**
   * Executes the Distiller prompt and returns a validated structured proposal.
   *
   * @param {DistillerProposalRequest} request - Distiller prompt, JSON schema, and model parameters.
   *
   * @returns {Promise<DistillerStructuredOutput>} Structured Distiller match and choice analysis.
   *
   * @throws {MemoryHarnessError} With code `'DISTILLER_EXECUTION_FAILED'` when the runner fails or times out.
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
  /**
   * Returns the loaded and validated `MemoryConfig` for this workspace.
   *
   * @returns {MemoryConfig} Validated unified memory configuration object.
   */
  getConfig(): MemoryConfig;

  /**
   * Executes `memory_init` at session start and after context compaction, returning the config-adapted
   * protocol and all unscoped `'general'` and `<role>` rules, lessons, and active notes.
   *
   * @param {MemoryInitInput} input - Session role and optional session identifier.
   *
   * @returns {Promise<MemoryInitOutput>} Protocol markdown and ordered unscoped memories.
   *
   * @throws {MemoryHarnessError} With `'INVALID_ROLE'`, `'VALIDATION_FAILED'`, or `'GIT_SYNC_FAILED'`.
   */
  init(input: MemoryInitInput): Promise<MemoryInitOutput>;

  /**
   * Executes `memory_load_scoped` for specific file paths, directories, or glob patterns.
   *
   * @param {MemoryLoadScopedInput} input - Target role, paths/globs to match, and optional session identifier.
   *
   * @returns {Promise<MemoryLoadScopedOutput>} Normalized query paths and matching scoped rules, lessons, and notes.
   *
   * @throws {MemoryHarnessError} With `'INVALID_ROLE'`, `'VALIDATION_FAILED'`, or `'GIT_SYNC_FAILED'`.
   */
  loadScoped(input: MemoryLoadScopedInput): Promise<MemoryLoadScopedOutput>;

  /**
   * Executes `memory_propose` to format, deduplicate, and evaluate capacity for a rule or lesson candidate.
   *
   * @param {MemoryProposeInput} input - Candidate rule or lesson payload and optional scope/incident context.
   *
   * @returns {Promise<MemoryProposeOutput>} Resolved Distiller proposal choices or subagent delegation payload.
   *
   * @throws {MemoryHarnessError} With `'INVALID_ROLE'`, `'VALIDATION_FAILED'`, `'LESSON_FORMAT_INVALID'`, `'RULE_PROTECTION_VIOLATION'`, `'DISTILLER_EXECUTION_FAILED'`, or `'GIT_SYNC_FAILED'`.
   */
  propose(input: MemoryProposeInput): Promise<MemoryProposeOutput>;

  /**
   * Executes `memory_commit` to atomically add, update, or remove a record in `memory.jsonl`.
   *
   * @param {MemoryCommitInput} input - Discriminated `'add' | 'update' | 'remove'` mutation payload.
   *
   * @returns {Promise<MemoryCommitOutput>} Committed/previous record snapshots, post-commit bucket status, and Git sync flags.
   *
   * @throws {MemoryHarnessError} With `'INVALID_ROLE'`, `'VALIDATION_FAILED'`, `'LESSON_FORMAT_INVALID'`, `'CAP_EXCEEDED'`, `'RECORD_NOT_FOUND'`, `'RULE_PROTECTION_VIOLATION'`, or `'GIT_SYNC_FAILED'`.
   */
  commit(input: MemoryCommitInput): Promise<MemoryCommitOutput>;

  /**
   * Executes `memory_drain_notes` in dry-run preview or destructive bulk-drain mode.
   *
   * @param {MemoryDrainNotesInput} input - Lifecycle mode selectors, optional role/path/ID filters, and `dryRun` flag.
   *
   * @returns {Promise<MemoryDrainNotesOutput>} Matched note records, drained IDs, and Git sync flags.
   *
   * @throws {MemoryHarnessError} With `'INVALID_ROLE'`, `'VALIDATION_FAILED'`, or `'GIT_SYNC_FAILED'`.
   */
  drainNotes(input: MemoryDrainNotesInput): Promise<MemoryDrainNotesOutput>;

  /**
   * Evaluates a file or directory tool interaction and returns unseen scoped memories for the active compaction epoch.
   *
   * @param {FileInteractionHookInput} input - Session ID, touched paths/globs, and optional role and transcript path.
   *
   * @returns {Promise<FileInteractionHookOutput>} Injection status, compaction epoch ID, formatted context, and newly injected records.
   *
   * @throws {MemoryHarnessError} With `'INVALID_ROLE'`, `'VALIDATION_FAILED'`, or `'GIT_SYNC_FAILED'`.
   */
  handleFileInteractionHook(input: FileInteractionHookInput): Promise<FileInteractionHookOutput>;
}
```

---

### 9.2 Single-Kind Module Table (`packages/memory/`)

In accordance with `docs/CODING_GUIDELINES.md` Rules 1.1–1.8, `@paraharness/memory` is organized into single-kind entity files:

| File Path | Entity Kind (`Rule 1.1`) | Primary Export & Responsibility |
| :--- | :---: | :--- |
| `src/schemas/memory-config.schema.ts` | `*.schema.ts` | `MemoryConfigSchema`, `MemoryCapRuleSchema`, `MemoryLessonFormatConfigSchema`, `MemoryDistillerConfigSchema`, `MemoryStorageConfigSchema`, `MemoryGitStorageConfigSchema` and inferred types. |
| `src/schemas/memory-record.schema.ts` | `*.schema.ts` | `MemoryRecordTypeSchema`, `MemoryRecordSchema`, `MemoryRuleRecordSchema`, `MemoryLessonRecordSchema`, `MemoryNoteRecordSchema`, `NoteLifecycleModeSchema`, `NoteLifecycleSchema`, `MemoryMetaSchema` and inferred types. |
| `src/schemas/memory-tools.schema.ts` | `*.schema.ts` | Input/output Zod schemas and inferred types for `memory_init`, `memory_load_scoped`, `memory_propose`, `memory_commit`, `memory_drain_notes`, `SessionIdSchema`, `FileInteractionHookInputSchema`, `FileInteractionHookOutputSchema`, `MemoryLatestRoleStateSchema`, `MemorySessionEpochStateSchema`, and `MemoryErrorCodeSchema`. |
| `src/memory-distiller-runner.ts` | `interface` | `MemoryDistillerRunner` and reachable `DistillerProposalRequest` sub-interface (`Rule 1.2`). |
| `src/memory-harness-options.ts` | `interface` | `MemoryHarnessOptions` configuration and dependency injection interface. |
| `src/memory-harness-contract.ts` | `interface` | `MemoryHarnessContract` programmatic surface interface. |
| `src/memory-harness-error.ts` | `class` | `MemoryHarnessError` structured domain error carrying `code: MemoryErrorCode` and `details?: Readonly<Record<string, unknown>>`. |
| `src/memory-harness.ts` | `class` | `MemoryHarness` stateful coordinator implementing `MemoryHarnessContract` and delegating domain phases to `src/internal/*` (`Rules 1.3, 3.1`). |
| `src/internal/load-memory-config.ts` | `function` | Discovers and validates `.agents/memory.config.json` $\to$ `.claude/memory.config.json` and pre-compiles `forbidRegexes` (§2.1). |
| `src/internal/normalize-memory-path-pattern.ts` | `function` | Normalizes and deduplicates paths/globs to repo-relative POSIX form (§4.1). |
| `src/internal/matches-context-scope.ts` | `function` | Implements the 4-way symmetric path/glob matching algorithm and synthetic probe helpers (§4.3). |
| `src/internal/resolve-record-cap-bucket.ts` | `function` | Implements the most-specific-bucket-wins specificity ranking and bucket partitioning (§5.2). |
| `src/internal/validate-lesson-text-format.ts` | `function` | Enforces deterministic string, single-sentence, required-substring, and pre-compiled forbidden-regex gates (§6.7). |
| `src/internal/evaluate-note-lifecycle-on-read.ts` | `function` | Evaluates `persistent`, `read-count`, `hard-expiry`, and `soft-expiry` transitions (§3.3). |
| `src/internal/read-memory-ledger.ts` | `function` | Parses `memory.jsonl` and `memory.meta.json`, reconciles monotonic `highWaterMarks` across raw records before expiry, and purges expired `hard-expiry` notes under `<ledgerPath>.lock` (§3.1, §3.3). |
| `src/internal/write-memory-ledger.ts` | `function` | Canonical-sorts records (`R*` $\to$ `L*` $\to$ `N*`) and atomically persists `memory.meta.json` first and `memory.jsonl` second via `write-file-atomic` (§3.1, §8.1). |
| `src/internal/sync-memory-git.ts` | `function` | Executes in-place `ensureMemoryGitCheckout`, fallback-author auto-commit, and 3-way diverged push retry loop (§8.2). |
| `src/internal/reconcile-diverged-memory-ledgers.ts` | `function` | Pure 3-way record union, ID collision re-numbering, and high-water-mark reconciliation for concurrent multi-repo Git pushes (§8.2.3). |
| `src/internal/build-memory-protocol.ts` | `function` | Generates the config-adapted `protocol` markdown instructions returned by `memory_init` (§6.2). |
| `src/internal/build-distiller-prompts.ts` | `function` | Constructs the KV-cacheable static `systemPrompt` and dynamic `userPrompt` for `memory_propose` (§6.4). |
| `src/internal/resolve-session-epoch-state.ts` | `function` | Incrementally scans `transcriptPath` for compaction checkpoints and role fallback, and loads/persists `.memory/.session-state/<sessionId>.json` and `latest-role.json` (§7.2). |
| `src/index.ts` | Barrel | Explicit `export` and `export type` surface of `@paraharness/memory` (`Rule 1.7`). |

---

## 10. Role Skill Integration (`peer/SKILL.md`)

When `@paraharness/memory` is enabled in a repository (where role skills live at `.agents/skills/{peer,lesson}/SKILL.md` or `skills/{peer,lesson}/SKILL.md`, and static lesson files live at `docs/lessons/*.md` or `LESSONS.md` / `lessons/<ROLE>.md`):
1. Delete static `.agents/skills/lesson/SKILL.md` (`skills/lesson/SKILL.md`), `docs/lessons/*.md` (`LESSONS.md`, `lessons/<ROLE>.md`), and `peer-notes.md`.
2. In `.agents/skills/peer/SKILL.md` (`skills/peer/SKILL.md`):
   - In the YAML frontmatter `description` (line 3), replace `records decisions in peer-notes.md and tests new questions against them` with `records decisions as unified memory notes and tests new questions against them`.
   - Under `## Debate and decision` (line 34), tighten the execution gate so mixed agreement+question turns stay in prose:
     > *"An instruction to act needs no special phrasing. Carry it out in the same turn, without asking again, when no part of the turn is still an open question and the change is either trivial with one valid solution or already settled between you. When building it would mean making a choice the owner has not seen, lay out the options with your pick and build once they choose."*
   - Under `## Proposals, prior decisions, and open questions` and `## Sources of truth, documents, and subagents`:
     - Replace `peer-notes.md` and `skills/lesson/SKILL.md` references with the unified memory tools:
       > *"At session start and after every compaction, call `memory_init({ role: 'peer' })` before your first reply. When open questions or gaps come in, check the loaded notes and rules (and call `memory_load_scoped` for the relevant paths), the specs, and the code before asking the owner anything."*
       > *"When the owner signs off on a design or tells you to record now, log the settled choice, its reason, and any accepted trade-off as a `persistent` note via `memory_commit`, keeping anything still open in prose. When a mistake or lesson candidate survives mechanical and doc fixes, or when the owner states a `rule: <text>`, run `memory_propose` and `memory_commit` per the memory protocol."*
   - Under `## Never` bullet 1 (line 64), replace `peer-notes.md` and forbid mutating memory calls (`memory_commit` or `memory_drain_notes`) on a question or mid-debate turn:
     > *"- Edit any file, call `memory_commit` or `memory_drain_notes`, dump an unrequested plan, or spawn downstream work on a question or mid-debate turn, and never build a non-trivial change on an approach the owner has not seen."*
