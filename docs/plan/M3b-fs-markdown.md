# Milestone 3b (`M3b`): `@harness-dsl/fs` & `@harness-dsl/markdown` Adapters

## 1. Scope & Package Directory

- **Milestone Wave:** Parallel Wave 2 — Scoped Adapter Builder (`c`) (Depends on Wave 1a `M1` -> Wave 1b `M2` completing)
- **Owned Files & Directories:**
  - `packages/fs/src/types.ts`
  - `packages/fs/src/path-jail.ts`
  - `packages/fs/src/matchers-guards.ts`
  - `packages/fs/src/checks-telemetry.ts`
  - `packages/fs/src/coding-tools.ts`
  - `packages/fs/src/lesson-store.ts`
  - `packages/fs/src/index.ts`
  - `packages/fs/test/guards-matchers.test.ts`
  - `packages/fs/test/coding-tools-jail.test.ts`
  - `packages/fs/test/lesson-store.test.ts`
  - `packages/markdown/src/frontmatter.ts`
  - `packages/markdown/src/loaders.ts`
  - `packages/markdown/src/index.ts`
  - `packages/markdown/test/markdown-loaders.test.ts`
- **Forbidden Directories:**
  - Do not modify root workspace files (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `pnpm-lock.yaml`) or `packages/core/**`.
  - Do not touch `packages/sqlite`, `packages/postgres`, `packages/node`, `packages/git`, `packages/claude`, `packages/openai`, `packages/github`, `packages/slack`, `packages/stripe`, `packages/netsuite`, or `packages/integration`.
  - Zero cross-milestone adapter imports: `packages/fs` imports only from `@harness-dsl/core`, `picomatch`, `zod`, and Node.js built-ins; `packages/markdown` imports only from `@harness-dsl/core`, `@harness-dsl/fs` (co-owned within `M3b`), `picomatch`, `zod`, and Node.js built-ins.

---

## 2. Exact Spec Grounding Table

Read the following sections in full before authoring any file in `M3b`:

| Document | Section | Line Range | Key Contracts & Filesystem/Markdown Semantics Covered |
| :--- | :--- | :--- | :--- |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §1.1 Package Boundaries & §1.2 Invariants 5–6 | `17, 19, 31–32` | `@harness-dsl/fs` and `@harness-dsl/markdown` responsibilities; host-root storage & control-plane path resolution vs `ResolutionContext.scopeHandle` |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §2.1–§2.3 Port Contracts | `46–197` | `ResolutionContext`, `Source<T>`, `ToolEffect`, `EffectMatcher`, `LeaseDelta`, `PolicyGuard`, `QuotaTripwire`, `TelemetryCollector`, `Check`, `ToolDefinition` |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §2.6 `LessonStore` & §3.4 Knowledge (`H.rules`, `H.skill`, `H.lessons`) | `780–829, 961–1030` | `GlobalRuleSchema`, `ScopedRuleSchema`, `SkillDefinitionSchema`, `LessonStore` contract |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §4.3 `@harness-dsl/fs` & §4.5 `@harness-dsl/markdown` | `1385–1400, 1465–1468` | `FsToolEffect`, `fs.text`, `fs.matchGlobs`, `fs.partitionMap`, `fs.inPartition`, `fs.boundaryGuard`, `fs.writeGuard` (`onlyExistingAtBaseRef`), `fs.allowWriteGlobs` (exact normalized path + glob), `fs.maxFilesMutated`, `fs.telemetry`, `fs.regexCheck`, `fs.jsonlLessonStore`, `fs.codingTools` / `fs.readOnlyTools`, `md.*` loaders |
| [`docs/CODING_SAMPLE.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_SAMPLE.md) | §2 Artifact Formats & §3.1 Partition Map | `21–115` | `.harness/` layout and exact Markdown YAML frontmatter formats for global rules, scoped rules, and skills |
| [`docs/CODING_SAMPLE.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_SAMPLE.md) | §6 `engineering-harness.ts` | `477–785` | All `fs.*` and `md.*` builder calls in `acme-engineering` |

---

## 3. File-by-File Architecture & Exported Symbols

### 3.1 `packages/fs/src/types.ts` & `packages/fs/src/index.ts`

```ts
import type {
  Check,
  EffectMatcher,
  LeaseDelta,
  LessonStore,
  PartitionGlobEntry,
  PartitionMap,
  PolicyGuard,
  QuotaTripwire,
  ScopePredicate,
  Source,
  TelemetryCollector,
  ToolDefinition,
  ToolEffect,
  TopologyDef,
} from '@harness-dsl/core';

export type { PartitionGlobEntry, PartitionMap };

export interface FsToolEffectAttributes extends Readonly<Record<string, unknown>> {
  readonly mode: 'read' | 'write';
  readonly paths: readonly string[];
  readonly existingPathsAtBaseRef?: readonly string[];
}

export interface FsToolEffect extends ToolEffect {
  readonly kind: 'fs:effect';
  readonly mutatesScope: boolean;
  readonly attributes: FsToolEffectAttributes;
}

export interface RunnerLike {
  exec?(
    argv: readonly string[],
    opts?: {
      readonly cwd?: string;
      readonly env?: Readonly<Record<string, string>>;
      readonly stdin?: 'closed' | string | Uint8Array;
      readonly timeoutMs?: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
}

export interface WorkspaceScopeHandle {
  readonly worktreePath?: string;
  readonly baseRef?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export const fs: {
  text(filePath: string, opts?: { readonly hostRootDir?: string }): Source<string>;
  matchGlobs(globs: readonly string[], mode?: 'read' | 'write' | 'any'): EffectMatcher;
  partitionMap<TPartition extends string>(
    topology: TopologyDef<TPartition>,
    mapping: Readonly<Record<TPartition, PartitionGlobEntry>>,
  ): PartitionMap<TPartition>;
  inPartition<TPartition extends string>(
    partitionMap: PartitionMap<TPartition>,
    partitionId: TPartition,
  ): ScopePredicate;
  boundaryGuard<TPartition extends string>(
    partitionMap: PartitionMap<TPartition>,
  ): PolicyGuard;
  writeGuard(opts: {
    readonly denyGlobs: readonly string[];
    readonly allowGlobs?: readonly string[];
    readonly onlyExistingAtBaseRef?: boolean;
  }): PolicyGuard;
  allowWriteGlobs(globs: readonly string[]): LeaseDelta;
  maxFilesMutated(count: number): QuotaTripwire;
  telemetry(): TelemetryCollector<{ filesRead: string[]; filesMutated: string[] }>;
  regexCheck(
    id: string,
    opts: {
      readonly targetGlobs: readonly string[];
      readonly forbidPattern: RegExp;
      readonly violationMessage: string;
    },
  ): Check<any>;
  jsonlLessonStore(opts: {
    readonly definitionsDir: string;
    readonly statsPath: string;
    readonly lockFile: string;
    readonly hostRootDir?: string;
  }): LessonStore;
  readOnlyTools(runner?: RunnerLike): readonly ToolDefinition<any>[];
  codingTools(runner?: RunnerLike): readonly ToolDefinition<any>[];
};
```

### 3.2 `packages/markdown/src/index.ts`

```ts
import type { GlobalRule, ScopedRule, SkillDefinition, Source } from '@harness-dsl/core';

export const md: {
  globalRules(globPattern: string, opts?: { readonly hostRootDir?: string }): Source<GlobalRule[]>;
  scopedRule(filePath: string, opts?: { readonly hostRootDir?: string }): Source<ScopedRule>;
  scopedRules(globPattern: string, opts?: { readonly hostRootDir?: string }): Source<ScopedRule[]>;
  skill(filePath: string, opts?: { readonly hostRootDir?: string }): Source<SkillDefinition>;
  skills(globPattern: string, opts?: { readonly hostRootDir?: string }): Source<SkillDefinition[]>;
};
```

---

## 4. Critical Implementation Invariants

1. **Workspace Jail, `realpath` Symlink Resolution & `node_modules` Denial (`SPEC.md` §4.3 line 1399):**
   - `fs.codingTools` and `fs.readOnlyTools` normalize every input path to a clean worktree-relative POSIX path (`path.posix.normalize`, rejecting `..` traversal or leading `/`).
   - Before emitting `FsToolEffect.attributes.paths` in `describeEffects` or touching the filesystem in `execute`, resolve `realWorktreeRoot = await nodeFs.realpath(worktreePath)` and resolve the deepest existing ancestor of the target path (plus the target path itself if it exists) via `nodeFs.realpath`, throwing a security error if the resolved path escapes `realWorktreeRoot`.
   - For write/edit/delete tools, any normalized path matching `**/node_modules/**` or `node_modules/**` is unconditionally rejected before touching disk.
   - For write/edit/delete tools when `scopeHandle.baseRef` is present, `describeEffects` checks `git cat-file -e ${baseRef}:${normalizedPath}` in `worktreePath` (using `scopeHandle.env`) and populates `existingPathsAtBaseRef`.
2. **Single-Guard Violating-Path Projection & Exact + Glob Matching (`SPEC.md` §2.2 line 103, §4.3 line 1394):**
   - `fs.matchGlobs(globs, mode)` and `fs.allowWriteGlobs(globs)` check **both** `globs.includes(normalizedPath)` (exact normalized string match, so literal paths containing brackets like `app/users/[id]/page.test.tsx` match without escaping) **and** `picomatch.isMatch(normalizedPath, globs, { dot: true })`.
   - `fs.writeGuard({ denyGlobs, allowGlobs, onlyExistingAtBaseRef })` and `fs.boundaryGuard(partitionMap)` filter each `FsToolEffect` down to **only** the specific file paths that violated that guard and were not covered by `allowGlobs` or any `LeaseDelta` in `activeLeases`.
   - When `onlyExistingAtBaseRef: true`, a write path is evaluated against `denyGlobs` if and only if `effect.attributes.existingPathsAtBaseRef?.includes(path)` is `true` (allowing new test files to be created freely while intercepting edits/deletions to existing test files).
3. **`fs.text` Host-Root vs `scopeHandle` Resolution (`SPEC.md` §2.1 line 55, §4.3 line 1390):**
   - When `ctx.scopeHandle` is `undefined` (control-plane `.instructions()`, `.rules()`, `.skills()`, `.guidelines()`, and initial `.sharedGrounding()` compilation), `fs.text(filePath)` resolves `filePath` against the immutable `hostRootDir` pinned at construction time.
   - When `ctx.scopeHandle` is provided with a `worktreePath` (in-run `updatedGroundingDiffs` calculation), `fs.text(filePath)` resolves `filePath` inside `worktreePath` (verifying `realpath` stays within `worktreePath`).
4. **`fs.regexCheck` Mutated-File-Only Scoping (`SPEC.md` §4.3 line 1397):**
   - Collects candidate paths from `ctx.observedEffects` (`kind === 'fs:effect'` and `mutatesScope === true`) and, if `scopeHandle.worktreePath` and `scopeHandle.baseRef` are present, `git diff --name-only <baseRef>` in `worktreePath`.
   - Filters candidate paths to those matching `targetGlobs` that currently exist on disk, reads their UTF-8 content, and returns `{ ok: false, deficits }` with `violationMessage` + file path for any file matching `forbidPattern` (resetting `RegExp.lastIndex = 0` per file).
5. **`fs.jsonlLessonStore` Immutability, Non-Blocking Locking & Atomic Rename (`SPEC.md` §4.3 line 1398):**
   - Resolves `definitionsDir`, `statsPath`, and `lockFile` against the pinned `hostRootDir`.
   - `admit(lesson)` writes an immutable JSON file `<definitionsDir>/<lessonId>.json` (`{ id, partition, directive, epochAtCreation, createdByRunId }`) where `lessonId` is `lesson-${sha256(`${partition ?? 'global'}:${directive}`).slice(0, 12)}` and initializes mutable stats in `statsPath`.
   - `<definitionsDir>/<lessonId>.json` is **never** modified after creation; `recordOutcomes`, `syncCreationEpochsForRuns` (`epochAtCreation` override), `markSignalEmitted` (`signalLastEmittedAt`), and `retire` (`retired: true`) are persisted exclusively in `statsPath`.
   - Concurrent operations serialize through an in-process async mutex queue combined with a non-blocking cross-process advisory lock on `lockFile` with exponential backoff (`1ms..50ms`), and write `statsPath` to `${statsPath}.tmp.${process.pid}.${++counter}`, `fsync(fd)`, close, and `fs.rename` to `statsPath`.
6. **`@harness-dsl/markdown` Zero-Dependency Frontmatter Translation (`SPEC.md` §1.1 line 19, §4.5 line 1467; `CODING_SAMPLE.md` §2.1):**
   - `packages/markdown/src/frontmatter.ts` implements a deterministic, zero-dependency YAML frontmatter parser over `--- ... ---` blocks supporting scalar strings (quoted and unquoted), inline `[a, b]` arrays, and multi-line `- item` lists (`id`, `description`, `partitions`, `globs`) alongside the Markdown body text.
   - `md.scopedRule` and `md.scopedRules` construct `ScopedRule` with `when: { partitions: frontmatter.partitions ?? [], effects: frontmatter.globs?.length ? fs.matchGlobs(frontmatter.globs, 'write') : undefined }`.
   - `md.skill` and `md.skills` construct `SkillDefinition` with `id: frontmatter.id ?? path.basename(filePath, '.md')`, `description: frontmatter.description ?? ''`, `when: (frontmatter.partitions?.length || frontmatter.globs?.length) ? { partitions: frontmatter.partitions ?? [], effects: frontmatter.globs?.length ? fs.matchGlobs(frontmatter.globs, 'write') : undefined } : undefined`, and `instructions: bodyText.trim()`.

---

## 5. Required Test Suite (`packages/fs/test/*.test.ts` & `packages/markdown/test/*.test.ts`)

1. **`guards-matchers.test.ts`:**
   - `fs.matchGlobs` mode filtering (`'write'` default vs `'read'` vs `'any'`).
   - `fs.allowWriteGlobs` matching both literal bracketed paths (`app/users/[id]/page.test.tsx`) and wildcard globs (`packages/api/**/*.test.ts`).
   - `fs.writeGuard` with `onlyExistingAtBaseRef: true` allowing newly created `packages/api/test/new.test.ts` while blocking existing `packages/api/test/auth.test.ts` and projecting only the violating paths into `violatedEffects`.
   - `fs.boundaryGuard` blocking `packages/db/src/index.ts` unless unlocked by an active `LeaseDelta`.
   - `fs.maxFilesMutated(4)`, `fs.telemetry()`, and `fs.regexCheck` (verifying pre-existing unmutated files matching `forbidPattern` do not fail `regexCheck`).
2. **`coding-tools-jail.test.ts`:**
   - `read_file`, `write_file`, `edit_file`, `delete_file`, `list_files`, `grep_search` inside a real git worktree.
   - Rejecting `../outside.txt` path traversal and rejecting a symlink inside the worktree pointing outside `worktreePath` via `realpath`.
   - Rejecting writes to `node_modules/pkg/index.js` and `packages/api/node_modules/foo/bar.js`.
   - Populating `existingPathsAtBaseRef` via `git cat-file -e <baseRef>:<path>` in `describeEffects`.
   - `fs.text` resolving against `hostRootDir` when `ctx.scopeHandle` is omitted vs `worktreePath` when `ctx.scopeHandle` is provided.
3. **`lesson-store.test.ts`:**
   - `fs.jsonlLessonStore` host-root path resolution, immutable `<definitionsDir>/<lessonId>.json` verification (byte-for-byte unchanged across `recordOutcomes`, `syncCreationEpochsForRuns`, `markSignalEmitted`, and `retire`), BM25 `relevanceScore` in $[0, 1]$, and concurrent parallel writers under non-blocking lock + atomic temp rename.
4. **`markdown-loaders.test.ts`:**
   - Parsing global rules, scoped rules, and skills matching exact `CODING_SAMPLE.md` §2.1 examples (`.harness/rules/global/typescript-invariants.md`, `.harness/rules/db-migrations.md`, `.harness/skills/db-migrations/SKILL.md`), verifying `when.effects` uses `fs.matchGlobs` and SHA-256 `digest` stability.

---

## 6. Verification Gate Commands

```bash
pnpm check:comments
pnpm --filter @harness-dsl/fs typecheck
pnpm --filter @harness-dsl/fs test
pnpm --filter @harness-dsl/markdown typecheck
pnpm --filter @harness-dsl/markdown test
```
