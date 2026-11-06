# Milestone M3b — `@harness-dsl/fs` & `@harness-dsl/markdown` Filesystem & Markdown Adapters

## 1. Scope & Ownership (`owned_dirs` & `forbidden_dirs`)

- **Milestone**: `M3b` (Wave 2 — Parallel Adapter Fan-Out `c`, depends on `M1`)
- **Packages**: `@harness-dsl/fs` (`packages/fs`) and `@harness-dsl/markdown` (`packages/markdown`)
- **`owned_dirs`**:
  - `packages/fs/src/**`
  - `packages/fs/test/**`
  - `packages/markdown/src/**`
  - `packages/markdown/test/**`
- **`forbidden_dirs`**:
  - `packages/core/**`
  - `packages/{sqlite,postgres,node,git,claude,openai,gemini,github,slack,stripe,netsuite,integration}/**`
  - Root workspace configs (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`) and `docs/**`
- **Cross-Adapter Independence Rule**:
  - `@harness-dsl/fs` and `@harness-dsl/markdown` must have **zero runtime or type imports** from each other or from any other M3 adapter package. Both depend exclusively on `@harness-dsl/core` (`workspace:*`), `picomatch`, `zod`, and Node built-ins (`node:fs`, `node:fs/promises`, `node:path`, `node:crypto`, `node:child_process`).

---

## 2. Normative Specification & Coding Sample Grounding

| Normative Source | Section & Exact Line Range | Grounded Scope in `M3b` |
| :--- | :--- | :--- |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §1.1–§1.2 (`lines 3–34`) | Pure passive AST nodes (`FsReadToolNode`, `FsEditToolNode`, `FsWriteToolNode`, `FsGlobToolNode`, `FsGrepToolNode`, `FsTextSourceNode`, `FsGlobSourceNode`, `FsGlobMatcherNode`, `FsPartitionMapNode`, `FsBoundaryGuardNode`, `FsWriteGuardNode`, `FsProtectGuardNode`, `FsReadOnlyGuardNode`, `FsAllowOnlyGuardNode`, `FsRequireReadBeforeWriteGuardNode`, `FsScopedWriteGuardNode`, `FsSecretLiteralsGuardNode`, `FsQuotaTripwireNode`, `FsTelemetryCollectorNode`, `FsRegexCheckNode`, `FsJsonlLessonStoreNode`, `MarkdownFrontmatterSourceNode`, `MarkdownSectionSourceNode`) and Invariant 5 (control-plane paths resolved against immutable host repository root). |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §2.2–§2.4 (`lines 682–1438`) | `BaseToolASTNode`, `BaseCheckASTNode`, `BasePolicyGuardASTNode`, `BaseQuotaTripwireASTNode`, `BaseTelemetryCollectorASTNode`, `BaseSourceASTNode`, `BaseLessonStoreASTNode`, `BaseEffectMatcherASTNode`, `ToolEffect`, `LeaseDelta`, `ToolDriver`, `ResolutionContext`, `StepExecutionContext`, `RuntimeExecutorRegistrySlice`. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §2.7 (`lines 2039–2086`) | `LessonStore`, `LessonRecord`, `LessonOutcome` implemented by `fs.jsonlLessonStore`. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §3.4.1–§3.4.3 (`lines 2206–2285`) | `GlobalRuleSchema`, `ScopedRuleSchema`, `ScopePredicateSchema` (`when.partitions` and `when.effects`), `md.globalRules`, `md.scopedRule`, `md.scopedRules` (translating YAML frontmatter `globs: string[]` into passive `FsGlobMatcherNode` descriptors `{ type: 'fs:match-globs', globs, mode: 'write' }` without importing `@harness-dsl/fs`), `md.skill`, `md.skills`, `md.frontmatter`, `md.section`. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §3.5 (`lines 2286–2323`) | Chained policy guard evaluation, `LeaseDelta` matching (`fs.allowWriteGlobs` matching both exact normalized file paths and glob patterns), `onlyExistingAtBaseRef` checking `existingPathsAtBaseRef`, and `proposedContent` checking. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §4.3 (`lines 2790–2898`) | Complete `@harness-dsl/fs` specification: `FsToolEffect`, `fs.text`, `fs.glob`, `fs.matchGlobs`, `fs.partitionMap`, `fs.inPartition`, `fs.boundaryGuard`, `fs.writeGuard`, `fs.protect`, `fs.readOnly`, `fs.allowOnly`, `fs.requireReadBeforeWrite`, `fs.scopedWrite`, `fs.secretLiterals`, `fs.allowWriteGlobs`, `fs.maxFilesMutated`, `fs.telemetry`, `fs.regexCheck`, `fs.jsonlLessonStore`, `fs.codingTools(runner)`, `fs.readOnlyTools(runner)`. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §4.5 (`lines 3086–3096, 3175`) | `MarkdownFrontmatterSourceNode`, `MarkdownSectionSourceNode`, and `@harness-dsl/markdown` builder contracts. |
| [`docs/CODING_SAMPLE.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_SAMPLE.md) | §2 (`lines 21–101`), §3.1 (`lines 106–115`), §6 (`lines 181, 184, 477–490, 535–709, 727, 743, 762, 780, 809–823, 854, 968, 1035`) | All `fs.*` and `md.*` invocations in `engineering-harness.ts`. |

---

## 3. Planned Module Decomposition & Public Exports

Every file in `packages/fs/src/**`, `packages/markdown/src/**`, and `test/fixtures/**` adheres to [`docs/CODING_GUIDELINES.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_GUIDELINES.md) §1–§5 (`<= 250` lines per file, single primary concept per file, `internal/` helpers, pure `src/index.ts` barrels, complete `/** ... */` JSDoc, and zero inline/non-JSDoc comments).

### 3.1 `packages/fs` (`@harness-dsl/fs`)

| File Path | Primary Category | Exported Symbols |
| :--- | :--- | :--- |
| `src/builders/fs-source-and-matcher-builders.ts` | `function` | `createFsTextSourceBuilder`, `createFsGlobSourceBuilder`, `createFsGlobMatcherBuilder`, `createFsPartitionMap`, `createFsInPartitionPredicate` |
| `src/builders/fs-guard-and-tripwire-builders.ts` | `function` | `createFsBoundaryGuardBuilder`, `createFsWriteGuardBuilder`, `createFsProtectGuardBuilder`, `createFsReadOnlyGuardBuilder`, `createFsAllowOnlyGuardBuilder`, `createFsRequireReadBeforeWriteGuardBuilder`, `createFsScopedWriteGuardBuilder`, `createFsSecretLiteralsGuardBuilder`, `createFsAllowWriteGlobsLeaseDelta`, `createFsMaxFilesMutatedBuilder` |
| `src/builders/fs-tool-check-and-store-builders.ts` | `function` | `createFsCodingTools`, `createFsReadOnlyTools`, `createFsTelemetryBuilder`, `createFsRegexCheckBuilder`, `createFsJsonlLessonStoreBuilder` |
| `src/builders/fs-namespace.constants.ts` | `const` | `fs`, `FsNamespace` |
| `src/executors/internal/jail-and-glob-helpers.ts` | `function` | `resolveJailedWorktreePath`, `compileGlobOrExactMatcher`, `checkPathsExistAtBaseRef` |
| `src/executors/fs-source-executors.ts` | `function` | `executeFsTextSource`, `executeFsGlobSource` |
| `src/executors/fs-tool-drivers.ts` | `function` | `createFsReadToolDriver`, `createFsEditToolDriver`, `createFsWriteToolDriver`, `createFsGlobToolDriver`, `createFsGrepToolDriver` |
| `src/executors/fs-policy-guard-executors.ts` | `function` | `evaluateFsBoundaryGuard`, `evaluateFsWriteGuard`, `evaluateFsProtectGuard`, `evaluateFsReadOnlyGuard`, `evaluateFsAllowOnlyGuard`, `evaluateFsRequireReadBeforeWriteGuard`, `evaluateFsScopedWriteGuard`, `evaluateFsSecretLiteralsGuard`, `evaluateFsGlobEffectMatcher` |
| `src/executors/fs-check-tripwire-and-telemetry.ts` | `function` | `executeFsRegexCheck`, `evaluateFsQuotaTripwire`, `collectFsTelemetry` |
| `src/stores/fs-jsonl-lesson-store.ts` | `class` | `FsJsonlLessonStore` (implementing `LessonStore`) |
| `src/stores/internal/fs-lesson-lock-and-atomic-io.ts` | `function` | `withNonBlockingAdvisoryFileLock`, `atomicWriteJsonFile`, `readLessonStatsFile` |
| `src/executors/fs-executors.constants.ts` | `const` | `fsExecutors: RuntimeExecutorRegistrySlice`, `createFsExecutors` |
| `src/index.ts` | `barrel` | Pure explicit re-exports of `fs`, `fsExecutors`, `createFsExecutors`, `FsJsonlLessonStore`, and all `Fs*Node` AST types from `@harness-dsl/core` |

### 3.2 `packages/markdown` (`@harness-dsl/markdown`)

| File Path | Primary Category | Exported Symbols |
| :--- | :--- | :--- |
| `src/builders/md-builders.ts` | `function` | `createMdGlobalRulesBuilder`, `createMdScopedRuleBuilder`, `createMdScopedRulesBuilder`, `createMdSkillBuilder`, `createMdSkillsBuilder`, `createMdFrontmatterBuilder`, `createMdSectionBuilder` |
| `src/builders/md-namespace.constants.ts` | `const` | `md`, `MdNamespace` |
| `src/parser/internal/parse-markdown-frontmatter.ts` | `function` | `parseMarkdownFrontmatter`, `extractMarkdownHeadingSection` |
| `src/executors/markdown-source-executors.ts` | `function` | `executeMarkdownFrontmatterSource`, `executeMarkdownSectionSource` |
| `src/executors/markdown-executors.constants.ts` | `const` | `markdownExecutors: RuntimeExecutorRegistrySlice`, `createMarkdownExecutors` |
| `src/index.ts` | `barrel` | Pure explicit re-exports of `md`, `markdownExecutors`, `createMarkdownExecutors`, `MarkdownFrontmatterSourceNode`, `MarkdownSectionSourceNode` |

---

## 4. Detailed Implementation Requirements

### 4.1 `@harness-dsl/fs` Tools, `FsToolEffect`, and Workspace Path Jail (`SPEC.md` §4.3 lines 2887–2898)
1. **`fs.codingTools(runner)` & `fs.readOnlyTools(runner)`**:
   - `fs.codingTools(runner)` returns the 5-tuple `[FsReadToolNode, FsEditToolNode, FsWriteToolNode, FsGlobToolNode, FsGrepToolNode]` (`readonly type: 'fs:read' | 'fs:edit' | 'fs:write' | 'fs:glob' | 'fs:grep'`, `readonly effectTracking: 'declared'`, `name: 'read_file' | 'edit_file' | 'write_file' | 'glob_files' | 'grep_files'`).
   - `fs.readOnlyTools(runner)` returns `[FsReadToolNode, FsGlobToolNode, FsGrepToolNode]`.
2. **Symlink-Safe Path Jail & `**/node_modules/**` Write Denial (`resolveJailedWorktreePath`)**:
   - Canonicalizes worktree-relative POSIX paths, resolves any existing target or parent symlinks via `realpath`, verifies the resolved path stays strictly inside `worktreePath` (or host root when `worktreePath` is absent), and denies writes to `**/node_modules/**`.
3. **`FsToolEffect` & `describeEffects`**:
   - Read tools (`fs:read`, `fs:glob`, `fs:grep`) emit `{ kind: 'fs:effect', mutatesScope: false, attributes: { mode: 'read', paths } }`.
   - Write/edit tools (`fs:write`, `fs:edit`) emit `{ kind: 'fs:effect', mutatesScope: true, attributes: { mode: 'write', paths, existingPathsAtBaseRef, proposedContent } }`, where `existingPathsAtBaseRef` is populated via `git cat-file -e <baseRef>:<path>` when `scopeHandle` has a `baseRef`, and `proposedContent` maps each target path to its proposed post-edit UTF-8 text.

### 4.2 `@harness-dsl/fs` Sources, Partition Maps, Guards, Lease Deltas, Checks, Tripwires & Telemetry (`SPEC.md` §4.3 lines 2888–2896)
1. **`fs.text(filePath)` & `fs.glob(globPattern)`**:
   - Compile to `FsTextSourceNode` (`'fs:text-source'`) and `FsGlobSourceNode` (`'fs:glob-source'`).
   - Control-plane definitions (when `ctx.scopeHandle` is omitted) resolve against the host repository root; when `ctx.scopeHandle` is provided (for in-run `updatedGroundingDiffs`), resolve against `scopeHandle.worktreePath`. Return `{ content, digest }` where `digest` is SHA-256 hex.
2. **`fs.matchGlobs(globs, mode = 'write')`, `fs.partitionMap`, `fs.inPartition`, `fs.boundaryGuard`**:
   - `fs.matchGlobs` compiles to `FsGlobMatcherNode` (`'fs:match-globs'`).
   - `fs.partitionMap(topology, mapping)` compiles to `FsPartitionMapNode` (`'fs:partition-map'`).
   - `fs.inPartition(partitionMap, partitionId)` returns a `ScopePredicate` (`{ partitions: [partitionId], effects: fs.matchGlobs(partitionMap.mapping[partitionId].globs, 'any') }`).
   - `fs.boundaryGuard(partitionMap)` compiles to `FsBoundaryGuardNode` (`'fs:boundary-guard'`), blocking write effects matching any partition's `boundaryGlobs` not covered by `activeLeases` (filtering `violatedEffects` strictly to the violating boundary paths).
3. **`fs.writeGuard`, `fs.protect`, `fs.readOnly`, `fs.allowOnly`, `fs.requireReadBeforeWrite`, `fs.scopedWrite`, `fs.secretLiterals` & `fs.allowWriteGlobs`**:
   - `fs.writeGuard({ denyGlobs, allowGlobs?, onlyExistingAtBaseRef? })`: when `onlyExistingAtBaseRef: true` is set, only paths present in `existingPathsAtBaseRef` are blocked by `denyGlobs` (allowing creation of new test files while intercepting edits to existing test files); projects `violatedEffects` filtered strictly to the violating paths not covered by `allowGlobs` or `activeLeases`.
   - `fs.allowWriteGlobs(globs)` produces a `LeaseDelta` (`{ type: 'harness:lease-delta', matcher: { type: 'fs:match-globs', globs, mode: 'write' } }`) whose evaluator matches **both** exact normalized file paths (`globs.includes(path)`) and `picomatch` glob patterns so literal paths containing brackets (`app/users/[id]/page.test.tsx`) match cleanly.
   - `fs.requireReadBeforeWrite()` rejects mutating a file that exists at `baseRef` unless `observedEffects` already contains a read effect for that path.
   - `fs.scopedWrite(partitionMap)` rejects mutating files outside the partitions listed in `ctx.activePartitions`.
   - `fs.secretLiterals(patterns?)` scans `proposedContent` for high-entropy / secret patterns (`sk-...`, `ghp_...`, `xoxb-...`, custom regexes).
4. **`fs.maxFilesMutated(count)`, `fs.telemetry()`, `fs.regexCheck(id, opts)`**:
   - `fs.maxFilesMutated` trips when distinct mutated file paths in `observedEffects` exceed `count`.
   - `fs.telemetry()` collects `{ filesRead, filesMutated }` from `observedEffects`.
   - `fs.regexCheck(id, { targetGlobs, forbidPattern, violationMessage })` compiles `forbidPattern: string | RegExp` into `{ forbidPattern: string, forbidFlags?: string }` and evaluates the regex strictly over files matching `targetGlobs` that were mutated in `observedEffects` (or mutated since `handle.baseRef`).

### 4.3 `fs.jsonlLessonStore` Crash-Safe Hybrid Store (`SPEC.md` §4.3 line 2896)
- Resolves `definitionsDir`, `statsPath`, and `lockFile` against the immutable host repository root (never an ephemeral worktree).
- Writes immutable `<definitionsDir>/<lessonId>.json` (`{ id, partition, directive, epochAtCreation, createdByRunId }`) once on `admit()`.
- Stores mutable telemetry counters (`recentOutcomes`, `totalCleanPasses`, `totalViolated`, `epochAtCreation` overrides from `syncCreationEpochsForRuns`, `signalLastEmittedAt` from `markSignalEmitted`, and `retired: boolean` from `retire`) in `statsPath`.
- Synchronizes access with an in-process async queue plus non-blocking advisory file lock on `lockFile` (`O_CREAT | O_EXCL` / `flock(LOCK_EX | LOCK_NB)` with async backoff), committing `statsPath` via `${statsPath}.tmp.${pid}.${counter}` + `fsync` + atomic `rename`.

### 4.4 `@harness-dsl/markdown` (`md.*` & `markdownExecutors`, `SPEC.md` §3.4 & §4.5)
- `md.globalRules(glob)`, `md.scopedRule(path)`, `md.scopedRules(glob)`, `md.skill(path)`, `md.skills(glob)`, `md.frontmatter(pathOrGlob)`, and `md.section(path, heading)` compile to passive `MarkdownFrontmatterSourceNode` (`'markdown:frontmatter'`) and `MarkdownSectionSourceNode` (`'markdown:section'`).
- Always resolves control-plane rule and skill paths against the host repository root (`SPEC.md` Invariant 5).
- Translates frontmatter `globs: string[]` on scoped rules and skills into passive `{ type: 'fs:match-globs', globs, mode: 'write' }` descriptors without importing `@harness-dsl/fs` (`SPEC.md` §3.4.1 line 2240).

---

## 5. Deterministic Test Suite Architecture (`test/**` & `test/fixtures/**`)

| File Path | Line Ceiling | Required Deterministic Test Cases |
| :--- | :--- | :--- |
| `packages/fs/test/fixtures/temp-fs-workspace.ts` | `<= 250` | Creates real temporary directories and git-initialized workspaces with symlinks and baseline commits. |
| `packages/fs/test/fs-tools-and-sources.test.ts` | `<= 400` | Verifies `fs.codingTools` and `fs.readOnlyTools` (`read_file`, `edit_file`, `write_file`, `glob_files`, `grep_files`), `realpath` symlink escape blocking, `**/node_modules/**` write denial, `describeEffects` (`existingPathsAtBaseRef` and `proposedContent`), and `fs.text` / `fs.glob` host-root vs worktree resolution. |
| `packages/fs/test/fs-guards-and-checks.test.ts` | `<= 400` | Verifies `fs.partitionMap`, `fs.inPartition`, `fs.boundaryGuard`, `fs.writeGuard` (including `onlyExistingAtBaseRef: true` allowing new test files while blocking existing test edits), `fs.allowWriteGlobs` (matching bracketed literal paths `app/users/[id]/page.test.tsx` and globs), `fs.protect`, `fs.readOnly`, `fs.allowOnly`, `fs.requireReadBeforeWrite`, `fs.scopedWrite`, `fs.secretLiterals`, `fs.maxFilesMutated`, `fs.telemetry`, and `fs.regexCheck` (evaluating only mutated files). |
| `packages/fs/test/fs-jsonl-lesson-store.test.ts` | `<= 400` | Verifies `FsJsonlLessonStore`: host-root path resolution, immutable `<definitionsDir>/<lessonId>.json` creation, atomic `statsPath` rename under concurrent `recordOutcomes`, `syncCreationEpochsForRuns`, `markSignalEmitted`, `retire`, and `queryCandidates` relevance scoring. |
| `packages/markdown/test/markdown-sources-and-rules.test.ts` | `<= 400` | Verifies `md.globalRules`, `md.scopedRule`, `md.scopedRules`, `md.skill`, `md.skills`, `md.frontmatter`, and `md.section`: YAML frontmatter parsing, translation of frontmatter `globs` into passive `fs:match-globs` descriptors, `GlobalRuleSchema` / `ScopedRuleSchema` validation, section extraction, and SHA-256 digest computation. |

---

## 6. Verification Gate Commands

Run from workspace root:

```bash
pnpm --filter @harness-dsl/fs --filter @harness-dsl/markdown typecheck
pnpm --filter @harness-dsl/fs --filter @harness-dsl/markdown test -- --reporter=verbose
test -z "$(git status --porcelain -- packages/core packages/sqlite packages/postgres packages/node packages/git packages/claude packages/openai packages/gemini packages/github packages/slack packages/stripe packages/netsuite packages/integration)"
```
