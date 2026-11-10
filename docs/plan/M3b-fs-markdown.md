# Milestone M3b — `@paraharness/fs` & `@paraharness/markdown` Filesystem & Markdown Adapters

## 1. Scope & Ownership (`owned_dirs` & `forbidden_dirs`)

- **Milestone**: `M3b` (Wave 2 — Parallel Adapter Fan-Out `c`, depends on `M1`)
- **Packages**: `@paraharness/fs` (`packages/fs`) and `@paraharness/markdown` (`packages/markdown`)
- **`owned_dirs`**:
  - `packages/fs/src/**`
  - `packages/fs/test/**`
  - `packages/markdown/src/**`
  - `packages/markdown/test/**`
- **`forbidden_dirs`**:
  - `packages/core/**`, `packages/lockfile/**`
  - `packages/{sqlite,postgres,node,git,claude,openai,gemini,github,slack,stripe,netsuite,integration}/**`
  - Root workspace configs (`package.json`, `eslint.config.mjs`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`) and `docs/**`
- **Cross-Adapter Independence Rule**:
  - `@paraharness/fs` and `@paraharness/markdown` must have **zero runtime or type imports** from each other or from any other M3 adapter package. `@paraharness/fs` depends exclusively on `@paraharness/core` (`workspace:*`), `@paraharness/lockfile` (`workspace:*`), `tinyglobby`, `picomatch`, `write-file-atomic`, `minisearch`, `p-queue`, `zod`, and Node built-ins; `@paraharness/markdown` depends exclusively on `@paraharness/core` (`workspace:*`), `mdast-util-from-markdown`, `mdast-util-to-markdown`, `mdast-util-frontmatter`, `micromark-extension-frontmatter`, `yaml`, `tinyglobby`, `picomatch`, `zod`, and Node built-ins.

### Approved External Libraries & Native Primitives (`CLAUDE.MD` #2 & `docs/CODING_GUIDELINES.md` Rule 3.5)

| Concern | Selected Package / Built-in | Version & License | Evaluated Alternatives & Rejection Reason | Lifecycle & Native/WASM Trade-offs | Owner Approval Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Cross-process & in-process advisory file locking (`fs.jsonlLessonStore`) | `@paraharness/lockfile` (`withFileLock`, backed by `p-queue` `^9.1.0` + `open(..., 'wx')`) | `workspace:*` (`MIT`) | `proper-lockfile` (unmaintained since 2020); copy-pasting lock helpers across `packages/fs` and `packages/git` (forbidden by `CLAUDE.MD` #2 Step 4) | Shared standalone `packages/lockfile` workspace package built in `M1`; `.unref()`ed heartbeat and deterministic `try / finally` unlock | Approved (`Rule 3.5`) |
| Crash-safe atomic file writes (`fs.jsonlLessonStore` stats & definitions) | `write-file-atomic` (`+ @types/write-file-atomic`) | `^8.0.0` (npm `8.0.0`, `ISC`, `0` deprecated, `0` CVEs) | Hand-rolled `.tmp.${pid}` + `fsync` + `rename` helper (forbidden by Rule 3.5) | Pure Node `fs` atomic temp-file write + `fsync` + `rename` with automatic cleanup on failure | Approved (`Rule 3.5`) |
| Fast recursive filesystem globbing (`fs:glob`, `fs.glob`, `md.globalRules`, `md.scopedRules`, `md.skills`) | `tinyglobby` (`glob`) | `^0.2.17` (npm `0.2.17`, `MIT`, `0` deprecated, `0` CVEs) | `fast-glob` (heavier transitive dependency tree), hand-rolled recursive `readdir` walker (forbidden by Rule 3.5) | Lightweight `fdir` + `picomatch` engine; always pass explicit `cwd` (worktree or host root) and `dot: true` | Approved (`Rule 3.5`) |
| Pre-compiled glob path matching (`fs.matchGlobs`, `fs.protect`, `fs.writeGuard`, `fs.boundaryGuard`) | `picomatch` (`+ @types/picomatch`) | `^4.0.3` (npm `4.0.7`, `MIT`, `0` deprecated, `0` CVEs) | `minimatch` (slower regex compilation), hand-rolled glob-to-regex converter (forbidden by Rule 3.5) | Pre-compile matchers once at guard/matcher registration (`Rule 4.4`), never inside per-file loops | Approved (`Rule 3.5`) |
| BM25 lesson recall (`FsJsonlLessonStore.queryCandidates`) | `minisearch` (`MiniSearch`) | `^7.2.0` (npm `7.2.0`, `MIT`, `0` deprecated, `0` CVEs) | Hand-rolled token/trigram BM25 scorer (forbidden by Rule 3.5) | Pure JS BM25 scoring normalized to $R(L, Q) \in [0, 1]$ | Approved (`Rule 3.5`) |
| In-process serialization (`FsJsonlLessonStore`) | `p-queue` (`new PQueue({ concurrency: 1 })`) | `^9.1.0` (`9.3.5` locked in `pnpm-lock.yaml`; npm `10.0.0` — pinned to `^9.1.0` / `9.3.5` for Node `>=22.0.0` engine compatibility and `PQueue` `idle`/`next` event semantics without mutating locked workspace manifests, `MIT`, `0` deprecated, `0` CVEs) | Hand-rolled promise queue (forbidden by Rule 3.5) | Queued-wait-only `AbortSignal` handling (`docs/lessons/BUILDER.md`) | Approved (`Rule 3.5`) |
| Markdown AST & frontmatter parsing / serialization (`md.frontmatter`, `md.section`, `md.globalRules`, `md.scopedRules`, `md.skills`) | `mdast-util-from-markdown` (`^2.1.0`), `mdast-util-to-markdown` (`^2.2.3`), `mdast-util-frontmatter` (`^2.0.1`), `micromark-extension-frontmatter` (`^2.0.0`) | `MIT` (`0` deprecated, `0` CVEs) | `gray-matter` (uses unmaintained `js-yaml` v3 and lacks AST heading-section extraction), hand-rolled regex Markdown/heading parser (forbidden by Rule 3.5) | Pure JS CommonMark + YAML frontmatter AST parser/serializer; extracts exact heading subtree for `md.section` without false-matching headings inside fenced code blocks | Approved (`Rule 3.5`) |
| YAML frontmatter parsing (`@paraharness/markdown`) | `yaml` (`parse`) | `^2.9.1` (npm `2.9.1`, `ISC`, `0` deprecated, `0` CVEs) | `js-yaml` (slower release cadence), hand-rolled YAML key-value splitter (forbidden by Rule 3.5) | Pure JS YAML 1.2 compliant parser with zero external dependencies | Approved (`Rule 3.5`) |
| Schema validation (`GlobalRuleSchema`, `ScopedRuleSchema`, tool args) | `zod` | `^4.6.7` (npm `4.6.7`, `MIT`, `0` deprecated, `0` CVEs) | Hand-rolled validation (forbidden by Rule 3.5) | Pure TypeScript runtime validation | Approved (`Rule 3.5`) |

---

## 2. Normative Specification & Coding Sample Grounding

| Normative Source | Section & Exact Line Range | Grounded Scope in `M3b` |
| :--- | :--- | :--- |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §1.1–§1.2 (`lines 3–34`) | Pure passive AST nodes (`FsReadToolNode`, `FsEditToolNode`, `FsWriteToolNode`, `FsGlobToolNode`, `FsGrepToolNode`, `FsTextSourceNode`, `FsGlobSourceNode`, `FsGlobMatcherNode`, `FsPartitionMapNode`, `FsBoundaryGuardNode`, `FsWriteGuardNode`, `FsProtectGuardNode`, `FsReadOnlyGuardNode`, `FsAllowOnlyGuardNode`, `FsRequireReadBeforeWriteGuardNode`, `FsScopedWriteGuardNode`, `FsSecretLiteralsGuardNode`, `FsQuotaTripwireNode`, `FsTelemetryCollectorNode`, `FsRegexCheckNode`, `FsJsonlLessonStoreNode`, `MarkdownFrontmatterSourceNode`, `MarkdownSectionSourceNode`) and Invariant 5 (control-plane paths resolved against immutable host repository root). |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §2.2–§2.4 (`lines 682–1477`) | `BaseToolASTNode`, `BaseCheckASTNode`, `BasePolicyGuardASTNode`, `BaseQuotaTripwireASTNode`, `BaseTelemetryCollectorASTNode`, `BaseSourceASTNode`, `BaseLessonStoreASTNode`, `BaseEffectMatcherASTNode`, `ToolEffect`, `LeaseDelta`, `ToolDriver`, `ResolutionContext`, `StepExecutionContext`, `RuntimeExecutorRegistrySlice`. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §2.7 (`lines 2078–2125`) | `LessonStore`, `LessonRecord`, `LessonOutcome` implemented by `fs.jsonlLessonStore`. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §3.4.1–§3.4.3 (`lines 2246–2325`) | `GlobalRuleSchema`, `ScopedRuleSchema`, `ScopePredicateSchema` (`when.partitions` and `when.effects`), `md.globalRules`, `md.scopedRule`, `md.scopedRules` (translating YAML frontmatter `globs: string[]` into passive `FsGlobMatcherNode` descriptors `{ type: 'fs:match-globs', id: 'fs:match-globs:...', globs, mode: 'write' }` without importing `@paraharness/fs`), `md.skill`, `md.skills`, `md.frontmatter`, `md.section`. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §3.5 (`lines 2326–2363`) | Chained policy guard evaluation, `LeaseDelta` matching (`fs.allowWriteGlobs` matching both exact normalized file paths and glob patterns), `onlyExistingAtBaseRef` checking `existingPathsAtBaseRef`, and `proposedContent` checking. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §4.3 (`lines 2830–2938`) | Complete `@paraharness/fs` specification: `FsToolEffect`, `fs.text`, `fs.glob`, `fs.matchGlobs`, `fs.partitionMap`, `fs.inPartition`, `fs.boundaryGuard`, `fs.writeGuard`, `fs.protect`, `fs.readOnly`, `fs.allowOnly`, `fs.requireReadBeforeWrite`, `fs.scopedWrite`, `fs.secretLiterals`, `fs.allowWriteGlobs`, `fs.violatedPaths`, `fs.maxFilesMutated`, `fs.telemetry`, `fs.regexCheck`, `fs.jsonlLessonStore(options?)`, `fs.codingTools(runner?)`, `fs.readOnlyTools(runner?)`. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §4.5 (`lines 3126–3136, 3215`) | `MarkdownFrontmatterSourceNode`, `MarkdownSectionSourceNode`, and `@paraharness/markdown` builder contracts. |
| [`docs/CODING_SAMPLE.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_SAMPLE.md) | §2 (`lines 21–101`), §3.1 (`lines 106–115`), §6 (`lines 181, 184, 477–490, 535–707, 725, 741, 760, 778, 807–821, 848, 960, 1027`) | All `fs.*` and `md.*` invocations in `engineering-harness.ts`. |

---

## 3. Planned Module Decomposition & Public Exports

Every file, class, method, and function in `packages/fs/src/**`, `packages/markdown/src/**`, and `test/fixtures/**` adheres to [`docs/CODING_GUIDELINES.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_GUIDELINES.md) §§1–5: each file, class, method, and function has **one clear responsibility at one uniform level of abstraction** (Rules 1.1–1.8 & 3.1–3.4), single-kind entity files per Rule 1.1, 1 root `interface` per file plus reachable `TSPropertySignature` / `TSMethodSignature` sub-interfaces per Rule 1.2, 1 `class` per file with optional co-located dedicated 1:1 `*Params`/`*Options` interfaces per Rule 1.3, 1 builder factory function per `create-*.ts` file with optional co-located dedicated 1:1 `*Params`/`*Options` interfaces per Rules 1.6 & 3.3, pure `src/index.ts` barrels, complete `/** ... */` JSDoc on every declaration per Rules 2.1–2.3, and zero inline/non-JSDoc comments per Rule 2.4. Orchestrators and store methods only sequence high-level phase calls and lifecycle boundaries (`try / finally`), delegating path jailing, glob compilation, atomic I/O, BM25 scoring, and Markdown AST parsing to focused `internal/` functions. Builders are free and expected to extract additional focused `internal/` phase, predicate, and projection helper files beyond the baseline §3 tables whenever responsibilities separate, while preserving all planned public exports.

### 3.1 `packages/fs` (`@paraharness/fs`)

| File Path | Primary Category | Exported Symbols |
| :--- | :--- | :--- |
| `src/builders/create-fs-text-source-builder.ts` | `function` | `createFsTextSourceBuilder` |
| `src/builders/create-fs-glob-source-builder.ts` | `function` | `createFsGlobSourceBuilder` |
| `src/builders/create-fs-glob-matcher-builder.ts` | `function` | `createFsGlobMatcherBuilder` |
| `src/builders/create-fs-partition-map.ts` | `function` | `createFsPartitionMap` |
| `src/builders/create-fs-in-partition-predicate.ts` | `function` | `createFsInPartitionPredicate` |
| `src/builders/create-fs-boundary-guard-builder.ts` | `function` | `createFsBoundaryGuardBuilder` |
| `src/builders/create-fs-write-guard-builder.ts` | `function` | `createFsWriteGuardBuilder` (plus co-located dedicated `FsWriteGuardOptions` interface) |
| `src/builders/create-fs-protect-guard-builder.ts` | `function` | `createFsProtectGuardBuilder` |
| `src/builders/create-fs-read-only-guard-builder.ts` | `function` | `createFsReadOnlyGuardBuilder` |
| `src/builders/create-fs-allow-only-guard-builder.ts` | `function` | `createFsAllowOnlyGuardBuilder` |
| `src/builders/create-fs-require-read-before-write-guard-builder.ts` | `function` | `createFsRequireReadBeforeWriteGuardBuilder` |
| `src/builders/create-fs-scoped-write-guard-builder.ts` | `function` | `createFsScopedWriteGuardBuilder` |
| `src/builders/create-fs-secret-literals-guard-builder.ts` | `function` | `createFsSecretLiteralsGuardBuilder` |
| `src/builders/create-fs-allow-write-globs-lease-delta.ts` | `function` | `createFsAllowWriteGlobsLeaseDelta` |
| `src/builders/extract-fs-violated-paths.ts` | `function` | `extractFsViolatedPaths` |
| `src/builders/create-fs-max-files-mutated-builder.ts` | `function` | `createFsMaxFilesMutatedBuilder` |
| `src/builders/create-fs-coding-tools.ts` | `function` | `createFsCodingTools` |
| `src/builders/create-fs-read-only-tools.ts` | `function` | `createFsReadOnlyTools` |
| `src/builders/create-fs-telemetry-builder.ts` | `function` | `createFsTelemetryBuilder` |
| `src/builders/create-fs-regex-check-builder.ts` | `function` | `createFsRegexCheckBuilder` (plus co-located dedicated `FsRegexCheckOptions` interface) |
| `src/builders/create-fs-jsonl-lesson-store-builder.ts` | `function` | `createFsJsonlLessonStoreBuilder` (plus co-located dedicated `FsJsonlLessonStoreOptions` interface) |
| `src/builders/fs-namespace-contract.ts` | `interface` | `FsNamespace` |
| `src/builders/fs-namespace.ts` | `const` | `fs: FsNamespace` |
| `src/executors/fs-tool-effect.ts` | `interface` | `FsToolEffect` (plus `TSPropertySignature` sub-interface `FsToolEffectAttributes`) |
| `src/executors/internal/jail-and-glob-helpers.ts` | `function` | `resolveJailedWorktreePath`, `compileGlobOrExactMatcher`, `checkPathsExistAtBaseRef` |
| `src/executors/fs-source-executors.ts` | `function` | `executeFsTextSource`, `executeFsGlobSource` |
| `src/executors/fs-read-tool-drivers.ts` | `function` | `createFsReadToolDriver`, `createFsGlobToolDriver`, `createFsGrepToolDriver` |
| `src/executors/fs-write-tool-drivers.ts` | `function` | `createFsEditToolDriver`, `createFsWriteToolDriver` |
| `src/executors/fs-path-guard-executors.ts` | `function` | `evaluateFsBoundaryGuard`, `evaluateFsProtectGuard`, `evaluateFsReadOnlyGuard`, `evaluateFsAllowOnlyGuard` |
| `src/executors/fs-write-guard-executors.ts` | `function` | `evaluateFsWriteGuard`, `evaluateFsRequireReadBeforeWriteGuard`, `evaluateFsScopedWriteGuard`, `evaluateFsSecretLiteralsGuard` |
| `src/executors/fs-glob-effect-matcher.ts` | `function` | `evaluateFsGlobEffectMatcher` |
| `src/executors/fs-check-tripwire-and-telemetry.ts` | `function` | `executeFsRegexCheck`, `evaluateFsQuotaTripwire`, `collectFsTelemetry` |
| `src/stores/fs-jsonl-lesson-store.ts` | `class` | `FsJsonlLessonStore` (implementing `LessonStore`) |
| `src/stores/internal/fs-lesson-lock-and-atomic-io.ts` | `function` | `withLessonFileLock`, `atomicWriteJsonFile`, `readLessonStatsFile` (delegating to `@paraharness/lockfile` `withFileLock` and `write-file-atomic`) |
| `src/executors/create-fs-executors.ts` | `function` | `createFsExecutors` |
| `src/executors/fs-executors.constants.ts` | `const` | `fsExecutors: RuntimeExecutorRegistrySlice` |
| `src/index.ts` | `barrel` | Pure explicit re-exports of `fs`, `FsNamespace`, `fsExecutors`, `createFsExecutors`, `FsJsonlLessonStore`, `FsToolEffect`, `FsWriteGuardOptions`, `FsRegexCheckOptions`, `FsJsonlLessonStoreOptions`, `violatedPaths`, `extractFsViolatedPaths`, all `createFs*` builder factories, and all `Fs*Node` AST types from `@paraharness/core` |

### 3.2 `packages/markdown` (`@paraharness/markdown`)

| File Path | Primary Category | Exported Symbols |
| :--- | :--- | :--- |
| `src/builders/md-frontmatter-source-builder.ts` | `interface` | `MdFrontmatterSourceBuilder<T>` |
| `src/builders/md-section-source-builder.ts` | `interface` | `MdSectionSourceBuilder<T>` |
| `src/builders/create-md-global-rules-builder.ts` | `function` | `createMdGlobalRulesBuilder` |
| `src/builders/create-md-scoped-rule-builder.ts` | `function` | `createMdScopedRuleBuilder` |
| `src/builders/create-md-scoped-rules-builder.ts` | `function` | `createMdScopedRulesBuilder` |
| `src/builders/create-md-skill-builder.ts` | `function` | `createMdSkillBuilder` |
| `src/builders/create-md-skills-builder.ts` | `function` | `createMdSkillsBuilder` |
| `src/builders/create-md-frontmatter-builder.ts` | `function` | `createMdFrontmatterBuilder` |
| `src/builders/create-md-section-builder.ts` | `function` | `createMdSectionBuilder` |
| `src/builders/md-namespace-contract.ts` | `interface` | `MdNamespace` |
| `src/builders/md-namespace.ts` | `const` | `md: MdNamespace` |
| `src/parser/parsed-markdown-document.ts` | `interface` | `ParsedMarkdownDocument` |
| `src/parser/internal/parse-markdown-frontmatter.ts` | `function` | `parseMarkdownFrontmatter`, `extractMarkdownHeadingSection` (backed by `mdast-util-from-markdown`, `mdast-util-to-markdown`, `mdast-util-frontmatter`, `micromark-extension-frontmatter`, and `yaml`) |
| `src/executors/markdown-source-executors.ts` | `function` | `executeMarkdownFrontmatterSource`, `executeMarkdownSectionSource` |
| `src/executors/create-markdown-executors.ts` | `function` | `createMarkdownExecutors` |
| `src/executors/markdown-executors.constants.ts` | `const` | `markdownExecutors: RuntimeExecutorRegistrySlice` |
| `src/index.ts` | `barrel` | Pure explicit re-exports of `md`, `MdNamespace`, `markdownExecutors`, `createMarkdownExecutors`, `MdFrontmatterSourceBuilder`, `MdSectionSourceBuilder`, `createMdGlobalRulesBuilder`, `createMdScopedRuleBuilder`, `createMdScopedRulesBuilder`, `createMdSkillBuilder`, `createMdSkillsBuilder`, `createMdFrontmatterBuilder`, `createMdSectionBuilder`, `MarkdownFrontmatterSourceNode`, `MarkdownSectionSourceNode` |

---

## 4. Detailed Implementation Requirements

### 4.0 Single-Kind File Separation, Co-Location & JSDoc Discipline (`docs/CODING_GUIDELINES.md` §§1–3)
1. **Single-Responsibility Decomposition, Single-Kind Entity Files & Co-Location (`Rules 1.1–1.8 & 3.1–3.4`)**:
   - Every file, class, method, and function in `packages/{fs,markdown}/src/**` and `packages/{fs,markdown}/test/fixtures/**` must have **one clear responsibility at one uniform level of abstraction** (`docs/CODING_GUIDELINES.md` §§1–3). Orchestrators and store methods only sequence high-level phase calls and lifecycle boundaries (`try / finally`), delegating context extraction, state initialization, lesson recall/scoring, iteration phases, and outcome projection to focused `internal/` functions. Builders are free and expected to extract additional focused `internal/` phase, predicate, and projection helper files beyond the baseline §3 table whenever responsibilities separate, while preserving all planned public exports.
   - Unrelated or different-kind declarations (`interface`, `function`, `class`, `const`, `type`) must **never** live in the same file in `packages/{fs,markdown}/src/**` or `packages/{fs,markdown}/test/fixtures/**`.
   - Each root `interface` (`*-builder.ts`, `*-namespace-contract.ts`, `fs-tool-effect.ts`, `parsed-markdown-document.ts`) lives in its own single-interface file (with reachable `TSPropertySignature` / `TSMethodSignature` sub-interfaces sharing that file per Rule 1.2).
   - Dedicated 1:1 `*Params` / `*Options` interfaces (`FsWriteGuardOptions`, `FsRegexCheckOptions`, `FsJsonlLessonStoreOptions`) are co-located in their consuming function file (`Rules 1.6 & 3.3`). Every builder factory function (`create-*.ts`) gets its own focused file (`Rule 1.6`); `FsJsonlLessonStore` gets its own single-class file; every `const` (`fs`, `md`, `fsExecutors`, `markdownExecutors`) lives in its own `const`-only file.
2. **JSDoc Anatomy & Approved Library Mandate (`docs/CODING_GUIDELINES.md` §2 & Rule 3.5)**:
   - In `@paraharness/fs`, use `@paraharness/lockfile` (`withFileLock`), `tinyglobby` (directory globbing), `picomatch` (pre-compiled glob matchers), `write-file-atomic` (atomic JSON/JSONL writes), `minisearch` (BM25 lesson recall), and `p-queue`. In `@paraharness/markdown`, use `mdast-util-from-markdown`, `mdast-util-to-markdown`, `mdast-util-frontmatter`, `micromark-extension-frontmatter`, `yaml`, `tinyglobby`, and `picomatch`.
   - Every `class` (and its constructor, methods, and properties), `interface` (and its properties and methods), `function` (public and `internal/`), and top-level `type` alias or `const` in `src/**` and `test/fixtures/**` must carry a complete `/** ... */` JSDoc block per `docs/CODING_GUIDELINES.md` §2 (clear summary sentence, behavioral description when non-obvious, and complete `@template`, `@param {Type} name - Description`, `@returns {Type} Description`, and `@throws` / `@note` / `@example` tags where applicable, with zero inline or body comments), enforced by `pnpm --filter @paraharness/fs --filter @paraharness/markdown lint`.

### 4.1 `@paraharness/fs` Tools, `FsToolEffect`, and Workspace Path Jail (`SPEC.md` §4.3 lines 2927–2938)
1. **`fs.codingTools(runner?)` & `fs.readOnlyTools(runner?)`**:
   - `fs.codingTools(runner?)` returns the 5-tuple `[FsReadToolNode, FsEditToolNode, FsWriteToolNode, FsGlobToolNode, FsGrepToolNode]` (`readonly type: 'fs:read' | 'fs:edit' | 'fs:write' | 'fs:glob' | 'fs:grep'`, `readonly effectTracking: 'declared'`, `name: 'read_file' | 'edit_file' | 'write_file' | 'glob_files' | 'grep_files'`, defaulting `runner` to `DEFAULT_NODE_RUNNER_AST_NODE` from `@paraharness/core` when omitted).
   - `fs.readOnlyTools(runner?)` returns `[FsReadToolNode, FsGlobToolNode, FsGrepToolNode]` (defaulting `runner` to `DEFAULT_NODE_RUNNER_AST_NODE` when omitted).
2. **Symlink-Safe Path Jail & `**/node_modules/**` Write Denial (`resolveJailedWorktreePath`)**:
   - Canonicalizes worktree-relative POSIX paths, resolves any existing target or parent symlinks via `realpath`, verifies the resolved path stays strictly inside `worktreePath` (or host root when `worktreePath` is absent), and denies writes to `**/node_modules/**`.
3. **`FsToolEffect` & `describeEffects`**:
   - Read tools (`fs:read`, `fs:glob`, `fs:grep`) emit `{ kind: 'fs:effect', mutatesScope: false, attributes: { mode: 'read', paths } }`.
   - Write/edit tools (`fs:write`, `fs:edit`) emit `{ kind: 'fs:effect', mutatesScope: true, attributes: { mode: 'write', paths, existingPathsAtBaseRef, proposedContent } }`, where `existingPathsAtBaseRef` is populated via `git cat-file -e <baseRef>:<path>` when `scopeHandle` has a `baseRef`, and `proposedContent` maps each target path to its proposed post-edit UTF-8 text.

### 4.2 `@paraharness/fs` Sources, Partition Maps, Guards, Lease Deltas, Checks, Tripwires & Telemetry (`SPEC.md` §4.3 lines 2928–2935)
1. **`fs.text(filePath)` & `fs.glob(globPattern)`**:
   - Compile to `FsTextSourceNode` (`'fs:text-source'`) and `FsGlobSourceNode` (`'fs:glob-source'`).
   - Control-plane definitions (when `ctx.scopeHandle` is omitted) resolve against the host repository root; when `ctx.scopeHandle` is provided (for in-run `updatedGroundingDiffs`), resolve against `scopeHandle.worktreePath`. Return `{ content, digest }` where `digest` is SHA-256 hex.
2. **`fs.matchGlobs(globs, mode = 'write')`, `fs.partitionMap`, `fs.inPartition`, `fs.boundaryGuard`**:
   - `fs.matchGlobs` compiles to `FsGlobMatcherNode` (`{ type: 'fs:match-globs', id: 'fs:match-globs:...', globs, mode }`, always setting deterministic `readonly id: string`).
   - `fs.partitionMap(topology, mapping)` compiles to `FsPartitionMapNode` (`'fs:partition-map'`).
   - `fs.inPartition(partitionMap, partitionId)` returns a `ScopePredicate` (`{ partitions: [partitionId], effects: fs.matchGlobs(partitionMap.mapping[partitionId].globs, 'any') }`).
   - `fs.boundaryGuard(partitionMap)` compiles to `FsBoundaryGuardNode` (`'fs:boundary-guard'`), blocking write effects matching any partition's `boundaryGlobs` not covered by `activeLeases` (filtering `violatedEffects` strictly to the violating boundary paths).
3. **`fs.writeGuard`, `fs.protect`, `fs.readOnly`, `fs.allowOnly`, `fs.requireReadBeforeWrite`, `fs.scopedWrite`, `fs.secretLiterals`, `fs.allowWriteGlobs` & `fs.violatedPaths`**:
   - `fs.writeGuard({ denyGlobs, allowGlobs?, onlyExistingAtBaseRef? })`: when `onlyExistingAtBaseRef: true` is set, only paths present in `existingPathsAtBaseRef` are blocked by `denyGlobs` (allowing creation of new test files while intercepting edits to existing test files); projects `violatedEffects` filtered strictly to the violating paths not covered by `allowGlobs` or `activeLeases`.
   - `fs.violatedPaths(violation: PolicyViolation): string[]` (also exported as named `violatedPaths` / `extractFsViolatedPaths`): extracts deduplicated filesystem paths in first-seen order from `violation.violatedEffects` (`effect.kind === 'fs:effect'`).
   - `fs.allowWriteGlobs(globs)` produces a `LeaseDelta` (`{ type: 'harness:lease-delta', id, grantedMatchers: [{ type: 'fs:match-globs', id: matcherId, globs, mode: 'write' }] }`) whose evaluator matches **both** exact normalized file paths (`globs.includes(path)`) and `picomatch` glob patterns so literal paths containing brackets (`app/users/[id]/page.test.tsx`) match cleanly.
   - `fs.requireReadBeforeWrite()` rejects mutating a file that exists at `baseRef` unless `observedEffects` already contains a read effect for that path.
   - `fs.scopedWrite(partitionMap)` rejects mutating files outside the partitions listed in `ctx.activePartitions`.
   - `fs.secretLiterals(patterns?)` scans `proposedContent` for high-entropy / secret patterns (`sk-...`, `ghp_...`, `xoxb-...`, custom regexes).
4. **`fs.maxFilesMutated(count)`, `fs.telemetry()`, `fs.regexCheck(id, opts)`**:
   - `fs.maxFilesMutated` trips when distinct mutated file paths in `observedEffects` exceed `count`.
   - `fs.telemetry()` collects `{ filesRead, filesMutated }` from `observedEffects`.
   - `fs.regexCheck(id, { targetGlobs, forbidPattern, violationMessage })` compiles `forbidPattern: string | RegExp` into `{ forbidPattern: string, forbidFlags?: string }` and evaluates the regex strictly over files matching `targetGlobs` that were mutated in `observedEffects` (or mutated since `handle.baseRef`).

### 4.3 `fs.jsonlLessonStore` Crash-Safe Hybrid Store (`SPEC.md` §4.3 line 2936 & `CODING_GUIDELINES.md` Rule 3.5)
- `fs.jsonlLessonStore(options?: { definitionsDir?: string; statsPath?: string; lockFile?: string })` defaults `definitionsDir` to `'.paraharness/lessons'`, `statsPath` to `` `${definitionsDir}-stats.json` ``, and `lockFile` to `` `${definitionsDir}.lock` ``, resolving all paths against the immutable host repository root (never an ephemeral worktree).
- Writes immutable `<definitionsDir>/<lessonId>.json` (`{ id, partition, directive, epochAtCreation, createdByRunId }`) once on `admit()` via `write-file-atomic`.
- Stores mutable telemetry counters (`recentOutcomes`, `totalCleanPasses`, `totalViolated`, `epochAtCreation` overrides from `syncCreationEpochsForRuns`, `signalLastEmittedAt` from `markSignalEmitted`, and `retired: boolean` from `retire`) in `statsPath`, and scores `queryCandidates` via `minisearch` BM25 normalized to $R(L, Q) \in [0, 1]$.
- Synchronizes access with `@paraharness/lockfile` (`withFileLock` on `lockFile` backed by `p-queue` `concurrency: 1` and cross-process atomic `open(lockPath, 'wx')` + `.unref()`ed `utimes` heartbeat + dead-PID/stale reclamation) and commits `statsPath` via `write-file-atomic`.

### 4.4 `@paraharness/markdown` (`md.*` & `markdownExecutors`, `SPEC.md` §3.4 & §4.5 & `CODING_GUIDELINES.md` Rule 3.5)
- `md.globalRules(glob)`, `md.scopedRule(path)`, `md.scopedRules(glob)`, `md.skill(path)`, `md.skills(glob)`, `md.frontmatter(pathOrGlob)`, and `md.section(path, heading)` compile to passive `MarkdownFrontmatterSourceNode` (`'markdown:frontmatter'`) and `MarkdownSectionSourceNode` (`'markdown:section'`).
- `md.globalRules`, `md.scopedRule`, `md.scopedRules`, `md.skill`, `md.skills`, and `md.frontmatter` set both `kind: 'global-rules' | 'scoped-rule' | 'scoped-rules' | 'skill' | 'skills' | 'frontmatter'` and `id: "md:${kind}:${pathOrGlob}"` on `MarkdownFrontmatterSourceNode<T>` so `executeMarkdownFrontmatterSource` dispatches deterministically on `node.kind` (with fallback to `node.id` prefix).
- Parses Markdown AST and YAML frontmatter via `mdast-util-from-markdown`, `mdast-util-to-markdown`, `mdast-util-frontmatter`, `micromark-extension-frontmatter`, and `yaml`, and resolves globs via `tinyglobby` (`Rule 3.5`).
- Always resolves control-plane rule and skill paths against the host repository root (`SPEC.md` Invariant 5).
- Translates frontmatter `globs: string[]` on scoped rules and skills into passive `{ type: 'fs:match-globs', id: 'fs:match-globs:...', globs, mode: 'write' }` descriptors without importing `@paraharness/fs` (`SPEC.md` §3.4.1 lines 2248–2281).

---

## 5. Deterministic Test Suite Architecture (`test/**` & `test/fixtures/**`)

All `test/fixtures/**` files strictly obey single-entity-kind file separation, single responsibility at one level of abstraction, and complete §2 JSDoc:

| File Path | Primary Category | Required Deterministic Test Cases |
| :--- | :--- | :--- |
| `packages/fs/test/fixtures/temp-fs-workspace-handle.ts` | `fixture (interface)` | Dedicated single-`interface` file (`TempFsWorkspaceHandle`) exposing `rootDir`, `worktreePath`, `baseRef`, and `cleanup()` for temporary filesystem test workspaces. |
| `packages/fs/test/fixtures/temp-fs-workspace.ts` | `fixture (function)` | Single-`function` helper (`createTempFsWorkspace`, with optional co-located dedicated `TempFsWorkspaceOptions` interface per Rule 1.6) creating real temporary directories and git-initialized workspaces with symlinks and baseline commits. |
| `packages/fs/test/fs-tools-and-sources.test.ts` | `test` | Verifies `fs.codingTools` and `fs.readOnlyTools` (`read_file`, `edit_file`, `write_file`, `glob_files` via `tinyglobby`, `grep_files`), `realpath` symlink escape blocking, `**/node_modules/**` write denial, `describeEffects` (`existingPathsAtBaseRef` and `proposedContent`), and `fs.text` / `fs.glob` host-root vs worktree resolution. |
| `packages/fs/test/fs-guards-and-checks.test.ts` | `test` | Verifies `fs.partitionMap`, `fs.inPartition`, `fs.boundaryGuard`, `fs.writeGuard` (including `onlyExistingAtBaseRef: true` allowing new test files while blocking existing test edits), `fs.violatedPaths` / `violatedPaths` (extracting deduplicated `fs:effect` string paths in first-seen order), `fs.allowWriteGlobs` (`grantedMatchers` with deterministic `id` matching bracketed literal paths `app/users/[id]/page.test.tsx` and globs), `fs.protect`, `fs.readOnly`, `fs.allowOnly`, `fs.requireReadBeforeWrite`, `fs.scopedWrite`, `fs.secretLiterals`, `fs.maxFilesMutated`, `fs.telemetry`, and `fs.regexCheck` (evaluating only mutated files). |
| `packages/fs/test/fs-jsonl-lesson-store.test.ts` | `test` | Verifies `FsJsonlLessonStore`: host-root path resolution, immutable `<definitionsDir>/<lessonId>.json` creation, atomic `statsPath` writes via `@paraharness/lockfile` + `write-file-atomic` under concurrent `recordOutcomes`, `syncCreationEpochsForRuns`, `markSignalEmitted`, `retire`, and `queryCandidates` `minisearch` BM25 relevance scoring. |
| `packages/markdown/test/markdown-sources-and-rules.test.ts` | `test` | Verifies `md.globalRules`, `md.scopedRule`, `md.scopedRules`, `md.skill`, `md.skills`, `md.frontmatter`, and `md.section`: `node.kind` and `id: "md:${kind}:${pathOrGlob}"` discriminator dispatch, `mdast-util-*` + `yaml` frontmatter parsing, translation of frontmatter `globs` into passive `fs:match-globs` descriptors with deterministic `id`, `GlobalRuleSchema` / `ScopedRuleSchema` validation, AST heading section extraction (ignoring `#` inside fenced code blocks), and SHA-256 digest computation. |

---

## 6. Verification Gate Commands

Run from workspace root (plus the `IMPL_LOOP.md` `baseline_dirty` diff check against `<non_sibling_forbidden_dirs_excluding_upstream_patches>`):

```bash
pnpm --filter @paraharness/fs --filter @paraharness/markdown lint
pnpm --filter @paraharness/fs --filter @paraharness/markdown typecheck
pnpm --filter @paraharness/fs --filter @paraharness/markdown test -- --reporter=verbose
test -z "$(git status --porcelain -- docs .agents .claude package.json tsconfig.base.json vitest.config.ts)"
```
