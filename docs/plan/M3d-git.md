# Milestone M3d — `@paraharness/git` CoW Worktree Scope, Git-Index Checkpoints & Stateless 3-Way Reconciliation

## 1. Scope & Ownership (`owned_dirs` & `forbidden_dirs`)

- **Milestone**: `M3d` (Wave 2 — Parallel Adapter Fan-Out `c`, depends on `M1`)
- **Package**: `@paraharness/git` (`packages/git`)
- **`owned_dirs`**:
  - `packages/git/src/**`
  - `packages/git/test/**`
- **`forbidden_dirs`**:
  - `packages/core/**`, `packages/lockfile/**`
  - `packages/{sqlite,postgres,fs,markdown,node,claude,openai,gemini,github,slack,stripe,netsuite,integration}/**`
  - Root workspace configs (`package.json`, `eslint.config.mjs`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`) and `docs/**`
- **Cross-Adapter Independence Rule**:
  - `@paraharness/git` must have **zero runtime or type imports** from any other M3 adapter package. It depends exclusively on `@paraharness/core` (`workspace:*`), `@paraharness/lockfile` (`workspace:*`), `es-module-lexer`, `write-file-atomic`, `picomatch`, `p-queue`, `zod`, the `git` CLI, and Node built-ins (`node:child_process`, `node:fs`, `node:fs/promises`, `node:path`, `node:crypto`).

### Approved External Libraries & Native Primitives (`CLAUDE.MD` #2 & `docs/CODING_GUIDELINES.md` Rule 3.5)

| Concern | Selected Package / Built-in | Version & License | Evaluated Alternatives & Rejection Reason | Lifecycle & Native/WASM Trade-offs | Owner Approval Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Cross-process & in-process advisory file locking (host repo `.git` worktree & ref mutations) | `@paraharness/lockfile` (`withFileLock`, backed by `p-queue` `^9.1.0` + `open(..., 'wx')`) | `workspace:*` (`MIT`) | `proper-lockfile` (unmaintained since 2020); copy-pasting lock helpers across `packages/fs` and `packages/git` (forbidden by `CLAUDE.MD` #2 Step 4) | Shared standalone `packages/lockfile` workspace package built in `M1`; `.unref()`ed heartbeat and deterministic `try / finally` unlock | Approved (`Rule 3.5`) |
| Crash-safe atomic metadata persistence (`<gitdir>/harness-meta.json`) | `write-file-atomic` (`+ @types/write-file-atomic`) | `^8.0.0` (npm `8.0.0`, `ISC`, `0` deprecated, `0` CVEs) | Hand-rolled temp-file rename helper (forbidden by Rule 3.5) | Atomic write + `fsync` + `rename` so `harness-meta.json` is never truncated on crash | Approved (`Rule 3.5`) |
| ESM/TypeScript export surface extraction (`git.publicSurfaceCrossTester`) | `es-module-lexer` (`init`, `parse`) | `^3.0.4` (npm `3.0.4`, `MIT`, `0` deprecated, `0` CVEs) | Hand-rolled regex `export` parser (fragile on comments/strings and forbidden by Rule 3.5) | Fast WASM-backed lexer initialized once via `await init` | Approved (`Rule 3.5`) |
| Stateless 3-way tree reconciliation, status checkpoints & patch equivalence (`commitChild`, `syncChild`, `syncRoot`, `patchEquivalence`) | `git` CLI (`git merge-tree --write-tree`, `git status --porcelain=v2 -z --no-renames --untracked-files=all`, `git patch-id --stable`) | Native Git CLI (`>=2.38`, `GPL-2.0` external binary via `execFile`) | `isomorphic-git` (lacks `git worktree` and `merge-tree --write-tree`), hand-rolled patch normalizer (forbidden by `CLAUDE.MD` #2 Step 1) | Uses isolated `GIT_INDEX_FILE` and all 9 `GIT_*` environment overrides; zero `.git/rebase-merge` state during 3-way merge | Approved (`Rule 3.5`) |
| Pre-compiled glob path matching (`.excludeFromCloneGlobs`, partition mapping) | `picomatch` (`+ @types/picomatch`) | `^4.0.3` (npm `4.0.7`, `MIT`, `0` deprecated, `0` CVEs) | Hand-rolled glob regex converter (forbidden by Rule 3.5) | Pre-compiled once at builder/scope initialization (`Rule 4.4`) | Approved (`Rule 3.5`) |
| Per-`parentHandle` working-tree flush serialization | `p-queue` (`new PQueue({ concurrency: 1 })`) | `^9.1.0` (`9.3.5` locked in `pnpm-lock.yaml`; npm `10.0.0` — pinned to `^9.1.0` / `9.3.5` for Node `>=22.0.0` engine compatibility and `PQueue` `idle`/`next` event semantics without mutating locked workspace manifests, `MIT`, `0` deprecated, `0` CVEs) | Hand-rolled promise mutex (forbidden by Rule 3.5) | Serializes concurrent `forkChild` / `commitChild` parent flushes with queued-wait-only `AbortSignal` handling (`docs/lessons/BUILDER.md`) | Approved (`Rule 3.5`) |
| Receipt & metadata schema validation (`ScopeReceiptSchema`, `SyncReceiptSchema`, `AbortMetaSchema`) | `zod` | `^4.6.7` (npm `4.6.7`, `MIT`, `0` deprecated, `0` CVEs) | Hand-rolled validation (forbidden by Rule 3.5) | Pure TypeScript runtime validation | Approved (`Rule 3.5`) |

---

## 2. Normative Specification & Coding Sample Grounding

| Normative Source | Section & Exact Line Range | Grounded Scope in `M3d` |
| :--- | :--- | :--- |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §1.1–§1.2 (`lines 3–34`) | Pure passive AST nodes (`GitWorktreeHandle`, `GitScopeReceipt`, `GitSyncReceipt`, `GitAbortMeta`, `GitCleanWorkingTreeNode`, `GitCowWorktreeNode`, `GitCommitAndPushNode`, `GitMergeQueueNode`, `GitSnapshotAndResetNode`, `GitKeepWorktreeNode`, `GitDiscardBranchNode`, `GitPatchEquivalenceNode`, `GitPublicSurfaceCrossTesterNode`, `GitRefReaderToolNode`, `GitCandidateComparisonToolNode`) and zero I/O at builder time. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §2.2–§2.5 (`lines 682–1543`) | `BaseIsolationScopeASTNode` (`capabilityTier: 'branchable'`), `BaseDomainStepASTNode`, `BaseCheckASTNode`, `BaseToolASTNode`, `BaseAbortHookASTNode`, `BaseScopeRewindHookASTNode`, `BaseCrossVerifierASTNode`, `IsolationScope`, `CheckpointableScope`, `BranchableScope` (`getConflictLease`), `ReconcileResult`, `RuntimeExecutorRegistrySlice`. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §3.5, §3.7.2, §3.9, §3.10 (`lines 2325–2655`) | Post-flight subprocess sandboxing (`serializeCheckpoint`, `diffEffects`, `restoreCheckpoint`), downward `.fork()` and `.speculate()` worktree reconciliation (`commitChild`, `syncChild`, `syncRoot`, `reattachRoot`, `reattachChild`), `git.snapshotAndReset()`, and `git.keepWorktree()` / `git.resetWorktree()`. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §4.4 (`lines 2938–3122`) | Complete `@paraharness/git` specification: `git.ScopeReceiptSchema`, `git.SyncReceiptSchema`, `git.AbortMetaSchema`, `git.cowWorktree(options?: { repo?: string; dir?: string })` (`<dir>/roots/<runId>` & `<dir>/forks/<runId>/<forkId>`, `<gitdir>/harness-meta.json`, `unresolvedConflictPaths`, `getConflictLease`, automatic parent working-tree flush, `GIT_CEILING_DIRECTORIES`, `reattachRoot` / `reattachChild`, `--porcelain=v2 -z --no-renames --untracked-files=all` checkpoints, worktree-local `.git` integrity in `diffEffects`, 4-step `restoreCheckpoint`, non-mutating `inspect`, stateless `git merge-tree --write-tree` in `commitChild` / `syncChild` / `syncRoot`, `reconcileStrategy`), `git.snapshotAndReset()`, `git.keepWorktree()`, `git.resetWorktree()`, `git.discardBranch()`, `git.publicSurfaceCrossTester`, `git.patchEquivalence`, `git.refReaderTools`, `git.candidateComparisonTools`, `git.commitAndPush`, `git.mergeQueue`. |
| [`docs/CODING_SAMPLE.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_SAMPLE.md) | §3.2 (`lines 116–127`), §4 (`lines 130–141`), §5 (`lines 144–173`), §6 (`lines 182, 492–530, 681, 692, 715–718, 750, 780, 786, 854, 909, 990–1000, 1051, 1077, 1095, 1189`) | Git-Index Checkpoint Sandboxing (`§3.2`), Two-Temperature Persistence (`§4`), Truth-Maintenance Protocols (`§5`), and all `git.*` invocations in `engineering-harness.ts`. |

---

## 3. Planned Module Decomposition & Public Exports (`packages/git/src/**`)

Every file, class, method, and function in `packages/git/src/**` and `packages/git/test/fixtures/**` adheres to [`docs/CODING_GUIDELINES.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_GUIDELINES.md) §§1–5: each file, class, method, and function has **one clear responsibility at one uniform level of abstraction** (Rules 1.1–1.8 & 3.1–3.4), single-kind entity files per Rule 1.1, 1 root `interface` per file plus reachable `TSPropertySignature` / `TSMethodSignature` sub-interfaces per Rule 1.2, 1 `class` per file with optional co-located dedicated 1:1 `*Params`/`*Options` interfaces per Rule 1.3, 1 builder factory function per `create-*.ts` file with optional co-located dedicated 1:1 `*Params`/`*Options` interfaces per Rules 1.6 & 3.3, pure `src/index.ts` barrel, complete `/** ... */` JSDoc on every declaration per Rules 2.1–2.3, and zero inline/non-JSDoc comments per Rule 2.4. Orchestrators and scope drivers only sequence high-level phase calls and lifecycle boundaries (`try / finally`), delegating git CLI execution, porcelain-v2 checkpoint diffing, stateless `git merge-tree --write-tree` reconciliation, and conflict pruning to focused `internal/` functions. Builders are free and expected to extract additional focused `internal/` phase, predicate, and projection helper files beyond the baseline §3 table whenever responsibilities separate, while preserving all planned public exports.

| File Path | Primary Category | Exported Symbols |
| :--- | :--- | :--- |
| `src/schemas/git-receipts.schema.ts` | `schema` | `GitScopeReceiptSchema`, `GitSyncReceiptSchema`, `GitAbortMetaSchema`, `HarnessMetaSchema`, `HarnessMetaRecord` |
| `src/builders/git-cow-worktree-builder.ts` | `interface` | `GitCowWorktreeBuilder` (plus `TSMethodSignature` sub-interfaces `GitCowWorktreeOptions`, `GitReconcileStrategyOptions`) |
| `src/builders/create-git-cow-worktree-builder.ts` | `function` | `createGitCowWorktreeBuilder` |
| `src/builders/git-commit-and-push-builder.ts` | `interface` | `GitCommitAndPushBuilder<TIn>` (plus `TSMethodSignature` sub-interface `GitCommitAndPushOptions<TIn>`) |
| `src/builders/create-git-commit-and-push-builder.ts` | `function` | `createGitCommitAndPushBuilder` |
| `src/builders/git-merge-queue-builder.ts` | `interface` | `GitMergeQueueBuilder<TIn, TOut>` (plus `TSMethodSignature` sub-interface `GitMergeQueueOptions`) |
| `src/builders/create-git-merge-queue-builder.ts` | `function` | `createGitMergeQueueBuilder` |
| `src/builders/create-git-snapshot-and-reset-builder.ts` | `function` | `createGitSnapshotAndResetBuilder` |
| `src/builders/create-git-keep-worktree-builder.ts` | `function` | `createGitKeepWorktreeBuilder` |
| `src/builders/create-git-reset-worktree-builder.ts` | `function` | `createGitResetWorktreeBuilder` |
| `src/builders/create-git-discard-branch-builder.ts` | `function` | `createGitDiscardBranchBuilder` |
| `src/builders/create-git-public-surface-cross-tester-builder.ts` | `function` | `createGitPublicSurfaceCrossTesterBuilder` (plus co-located dedicated `GitPublicSurfaceCrossTesterOptions` interface) |
| `src/builders/create-git-patch-equivalence-builder.ts` | `function` | `createGitPatchEquivalenceBuilder` |
| `src/builders/create-git-ref-reader-tools.ts` | `function` | `createGitRefReaderTools` |
| `src/builders/create-git-candidate-comparison-tools.ts` | `function` | `createGitCandidateComparisonTools` |
| `src/builders/git-namespace-contract.ts` | `interface` | `GitNamespace` |
| `src/builders/git-namespace.ts` | `const` | `git: GitNamespace` (mounting `ScopeReceiptSchema`, `SyncReceiptSchema`, `AbortMetaSchema`, and all `git.*` builders) |
| `src/executors/git-checkpoint-payload.ts` | `interface` | `GitCheckpointPayload` |
| `src/executors/internal/git-cli-runner.ts` | `function` | `runGitCommand`, `buildIsolatedWorktreeGitEnv`, `readHarnessMeta`, `writeHarnessMeta` (delegating to `write-file-atomic` and `@paraharness/lockfile` `withFileLock`) |
| `src/executors/internal/porcelain-v2-and-checkpoints.ts` | `function` | `computeWorktreeStatusMap`, `serializeGitWorktreeCheckpoint`, `diffGitWorktreeEffects`, `restoreGitWorktreeCheckpoint` |
| `src/executors/internal/conflict-pruning-and-parent-flush.ts` | `function` | `pruneResolvedConflictPaths`, `hasPairedConflictMarkers`, `flushParentWorkingTreeCleanChanges`, `buildConflictLeaseDelta` |
| `src/executors/internal/stateless-merge-tree-reconcile.ts` | `function` | `inspectGitWorktreeNonMutating`, `commitChildViaMergeTree`, `syncChildViaMergeTree`, `syncRootViaMergeTree` |
| `src/executors/internal/worktree-acquire-and-fork.ts` | `function` | `acquireRootWorktree`, `forkChildWorktree`, `releaseWorktreeAndPinRef` |
| `src/executors/internal/worktree-crash-reattach.ts` | `function` | `reattachRootWorktree`, `reattachChildWorktree` |
| `src/executors/git-cow-worktree-scope.ts` | `class` | `GitCowWorktreeScopeDriver` (implementing `BranchableScope<GitWorktreeHandle, GitScopeReceipt, GitSyncReceipt>`) |
| `src/executors/git-commit-and-merge-steps.ts` | `function` | `executeGitCommitAndPushStep`, `executeGitMergeQueueStep` |
| `src/executors/git-hooks-and-checks.ts` | `function` | `executeGitCleanWorkingTreeCheck`, `executeGitSnapshotAndResetHook`, `executeGitKeepWorktreeHook`, `executeGitDiscardBranchHook` |
| `src/executors/git-cross-verifiers-and-tools.ts` | `function` | `executeGitPublicSurfaceCrossTester`, `executeGitPatchEquivalence`, `createGitRefReaderToolDrivers`, `createGitCandidateComparisonToolDrivers` (backed by `es-module-lexer` and `git patch-id --stable`) |
| `src/executors/create-git-executors.ts` | `function` | `createGitExecutors` |
| `src/executors/git-executors.constants.ts` | `const` | `gitExecutors: RuntimeExecutorRegistrySlice` |
| `src/index.ts` | `barrel` | Pure explicit re-exports of `git`, `GitNamespace`, `gitExecutors`, `createGitExecutors`, `GitCowWorktreeScopeDriver`, `GitScopeReceiptSchema`, `GitSyncReceiptSchema`, `GitAbortMetaSchema`, `HarnessMetaSchema`, `HarnessMetaRecord`, `GitCowWorktreeBuilder`, `GitCowWorktreeOptions`, `GitReconcileStrategyOptions`, `GitCommitAndPushBuilder`, `GitCommitAndPushOptions`, `GitMergeQueueBuilder`, `GitMergeQueueOptions`, `GitPublicSurfaceCrossTesterOptions`, all `createGit*` builder factories, and all `Git*` AST types from `@paraharness/core` |

---

## 4. Detailed Implementation Requirements

### 4.0 Single-Kind File Separation, Co-Location & JSDoc Discipline (`docs/CODING_GUIDELINES.md` §§1–3)
1. **Single-Responsibility Decomposition, Single-Kind Entity Files & Co-Location (`Rules 1.1–1.8 & 3.1–3.4`)**:
   - Every file, class, method, and function in `packages/git/src/**` and `packages/git/test/fixtures/**` must have **one clear responsibility at one uniform level of abstraction** (`docs/CODING_GUIDELINES.md` §§1–3). Orchestrators and scope drivers only sequence high-level phase calls and lifecycle boundaries (`try / finally`), delegating context extraction, state initialization, lesson recall/scoring, iteration phases, and outcome projection to focused `internal/` functions. Builders are free and expected to extract additional focused `internal/` phase, predicate, and projection helper files beyond the baseline §3 table whenever responsibilities separate, while preserving all planned public exports.
   - Unrelated or different-kind declarations (`interface`, `function`, `class`, `const`, `type`) must **never** live in the same file in `packages/git/src/**` or `packages/git/test/fixtures/**` (sole exception: `src/schemas/git-receipts.schema.ts` pairing Zod schemas with their `z.infer` types).
   - Each root `interface` (`*-builder.ts`, `git-checkpoint-payload.ts`, `git-namespace-contract.ts`) lives in its own single-interface file, co-locating secondary interfaces reachable via `TSPropertySignature` or `TSMethodSignature` parameter/return types (`GitCowWorktreeOptions`, `GitReconcileStrategyOptions`, `GitCommitAndPushOptions<TIn>`, `GitMergeQueueOptions`) per Rule 1.2.
   - Dedicated 1:1 `*Params` / `*Options` interfaces (`GitPublicSurfaceCrossTesterOptions`) are co-located in their consuming function file (`Rules 1.6 & 3.3`). Every builder factory function (`create-*.ts`) gets its own focused file (`Rule 1.6`); `GitCowWorktreeScopeDriver` gets its own single-class file; `git` and `gitExecutors` live in their own `const`-only files.
2. **JSDoc Anatomy & Approved Library Mandate (`docs/CODING_GUIDELINES.md` §2 & Rule 3.5)**:
   - Use `@paraharness/lockfile` (`withFileLock`), `es-module-lexer` for export surface extraction in `publicSurfaceCrossTester`, `git patch-id --stable` in `patchEquivalence`, `write-file-atomic` for `harness-meta.json` persistence, `picomatch` for path exclusion globs, and `p-queue` (`concurrency: 1`) for per-`parentHandle` flush serialization.
   - Every `class` (and its constructor, methods, and properties), `interface` (and its properties and methods), `function` (public and `internal/`), and top-level `type` alias or `const` in `src/**` and `test/fixtures/**` must carry a complete `/** ... */` JSDoc block per `docs/CODING_GUIDELINES.md` §2 (clear summary sentence, behavioral description when non-obvious, and complete `@template`, `@param {Type} name - Description`, `@returns {Type} Description`, and `@throws` / `@note` / `@example` tags where applicable, with zero inline or body comments), enforced by `pnpm --filter @paraharness/git lint`.

### 4.1 `GitNamespace`, `GitCowWorktreeBuilder`, Disjoint Worktree Layout & Crash Reattachment (`SPEC.md` §4.4 lines 3088–3097)
1. **`GitNamespace` & `GitCowWorktreeBuilder` Fluent Contract**:
   - Mounts `ScopeReceiptSchema`, `SyncReceiptSchema`, and `AbortMetaSchema` directly on the `git` namespace (`git.ScopeReceiptSchema`, `git.SyncReceiptSchema`, `git.AbortMetaSchema`) alongside all `git.*` builder factories.
   - `git.cowWorktree(options?: { repo?: string; dir?: string })` (defaulting `repo` to `'.'` and `dir` to `'.paraharness/worktree'`) returns `GitCowWorktreeBuilder` exposing `.excludeFromCloneGlobs(globs)`, `.setup(cmd)`, `.lockfileGate(lockfilePath)`, `.checkpointPolicy(policy)`, `.reconcileStrategy(mode, opts?)` (supporting `(mode: 'rebase-onto-base' | 'batch-merge-train', opts?: { verifyWith?: MaybeBuilder<CheckASTNode<GitWorktreeHandle>>; maxBatchSize?: number })` as well as a single-object overload), and `.toAST(): GitCowWorktreeNode` (populating default `conflictCleanCheck: { type: 'git:clean-working-tree', id: 'git-clean-working-tree' }`, `receiptSchema: git.ScopeReceiptSchema`, and `syncSchema: git.SyncReceiptSchema`).
2. **Disjoint Sibling Directories & `.lockfileGate` / `.setup` CoW Hydration**:
   - Task root worktrees live at `<dir>/roots/<runId>` and child fork worktrees at `<dir>/forks/<runId>/<forkId>` via `git worktree add --detach`, with isolated `<hostRepo>/.git/worktrees/<worktreeId>/harness-meta.json` storing `{ baseRef, baseBranch, branchName, unresolvedConflictPaths, pendingParentHeadSha?, inFlightMerge?, inFlightCommitAndPush? }`.
   - When `.lockfileGate(lockfilePath)` (e.g., `'pnpm-lock.yaml'`) and `.setup(cmd)` are configured, computes the SHA-256 digest of `lockfilePath` against the host repo's cached lockfile hash: on a cache hit, hardlinks/CoW-clones `node_modules` (excluding `.excludeFromCloneGlobs`); on a gate miss (when `lockfilePath` differs), unlinks/replaces any hardlinked `node_modules` directory before running `.setup(cmd)` so dependency installation never mutates shared host inodes.
   - Injects `GIT_CEILING_DIRECTORIES=<path.dirname(worktreePath)>`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_OPTIONAL_LOCKS=0`, `GIT_CONFIG_COUNT=2`, `GIT_CONFIG_KEY_0=commit.gpgsign`, `GIT_CONFIG_VALUE_0=false`, `GIT_CONFIG_KEY_1=core.hooksPath`, and `GIT_CONFIG_VALUE_1=/dev/null`.
3. **Automatic Conflict Pruning, `getConflictLease(handle)` & Automatic Parent Flush (`SPEC.md` §4.4 line 3094)**:
   - `getConflictLease(handle)` returns `{ type: 'harness:lease-delta', id, grantedMatchers: [{ type: 'fs:match-globs', id: matcherId, globs: Object.keys(handle.unresolvedConflictPaths), mode: 'write' }] }` when `unresolvedConflictPaths` is non-empty (without importing `@paraharness/fs`).
   - Prunes any path in `unresolvedConflictPaths` whose working-tree `${mode}:${sha256}` differs from its recorded conflict-time digest (or was unlinked) and contains no paired conflict markers (`^<{7} ` ... `^={7}( |$)` ... `^>{7} `).
   - Auto-commits non-conflicted dirty working-tree files on `parentHandle` onto `parentHandle.HEAD` before `forkChild` (guarded by an internal per-`parentHandle` async mutex), `syncChild`, or `commitChild` while keeping `parentHandle.baseRef` pinned.
4. **Crash Reattachment (`reattachRoot` / `reattachChild`)**:
   - Completes interrupted `pendingParentHeadSha`, `inFlightMerge`, or rolls back `inFlightCommitAndPush` on reboot without losing uncommitted working-tree edits.

### 4.2 Hardened Git-Index Checkpoints (`serializeCheckpoint`, `diffEffects`, `restoreCheckpoint`, `SPEC.md` §4.4 lines 3098–3102)
- `serializeCheckpoint(handle)` captures `{ headSha, headRawContent, indexTreeSha, infoExcludeContent, meta, statusMap, treeSha, oversizedUntrackedBlobs }` using `git status --porcelain=v2 -z --no-renames --untracked-files=all` and a temporary `GIT_INDEX_FILE`.
- `diffEffects(fromCheckpoint, handle)` verifies worktree-local `.git` integrity (`HEAD`, `indexTreeSha`, `info/exclude`, `harness-meta.json`) and `**/node_modules/**` untampered state (immediately calling `restoreCheckpoint` and throwing a non-leasable scope integrity error if tampered), checks `--ignored=matching` when any `**/.gitignore` changed, and emits the symmetric difference between `fromCheckpoint.statusMap` and `currentStatusMap` as `FsToolEffect`.
- `restoreCheckpoint(handle, fromCheckpoint)` executes the 4-step restoration protocol (`HEAD`/`info/exclude`/`harness-meta.json`/`.gitignore` restore $\to$ `symDiff` unlink $\to$ `<tmpIndex> git read-tree` + `checkout-index` $\to$ `oversizedUntrackedBlobs` restore).

### 4.3 Non-Mutating `inspect`, Host Ref Pinning & Stateless `git merge-tree --write-tree` Reconciliation (`SPEC.md` §4.4 lines 3103–3114)
- `inspect(handle)` uses a temporary `GIT_INDEX_FILE` to write a commit object over `handle.baseRef` without mutating the live worktree `HEAD` or `.git/index`, and pins the resulting commit SHA under `refs/harness/candidates/<run-id>/<branch-index>` on the host repository when inspecting speculative candidate branches.
- `release(handle)` pins the final commit SHA under `refs/harness/completed/roots/<run-id>` (for root worktrees) or `refs/harness/completed/forks/<run-id>/<fork-id>` (for child fork worktrees) on the host repository before removing the worktree directory (`git worktree remove --force`).
- `commitChild(child, parent)`, `syncChild(parent, pausedChild)`, and `syncRoot(rootHandle, prereqReceipts)` synthesize commits sharing $C_0 = \text{baseRef}$ as their sole immediate parent and run `git merge-tree --write-tree`, materializing conflicts cleanly into the child/root working tree via `inFlightMerge` + `checkout-index -f -a` with zero `.git/rebase-merge` state and recording `unresolvedConflictPaths`.

### 4.4 Hooks, `CrossVerifierBuilder`, Tools, `git.commitAndPush` & `git.mergeQueue` (`SPEC.md` §4.4 lines 3115–3122)
- `git.snapshotAndReset()` idempotently snapshots the working tree over `handle.baseRef` to `refs/harness/aborted/<run-id>/<stepExecId>`, resets to `handle.baseRef`, and clears `unresolvedConflictPaths`.
- `git.keepWorktree()` (`resetsRunOverlay: false`) and `git.resetWorktree()` / `git.discardBranch()` (`resetsRunOverlay: true`).
- `git.publicSurfaceCrossTester({ runner?, partitionMap })` (defaulting `runner` to `DEFAULT_NODE_RUNNER_AST_NODE` from `@paraharness/core`) and `git.patchEquivalence(...)` return `CrossVerifierBuilder` instances exposing `.id`, `.reportSchema`, and `.toAST()` (`GitPublicSurfaceCrossTesterNode` and `GitPatchEquivalenceNode`), with executors `executeGitPublicSurfaceCrossTester` (using `es-module-lexer` to extract exported symbol surfaces across candidate branches) and `executeGitPatchEquivalence` (computing canonical diff patch IDs via `git diff <baseRef>..<candidateRef> | git patch-id --stable`).
- `git.refReaderTools(runner?)` (`readRefFile`, `diffRefs`, `listRefFiles`) and `git.candidateComparisonTools(runner?)` (`diffCandidates`, `readCandidateFile`, `evalInCandidates` wrapping candidate benchmark runs in `serializeCheckpoint` + `try/finally { restoreCheckpoint }`), both defaulting `runner` to `DEFAULT_NODE_RUNNER_AST_NODE` when omitted.
- `git.commitAndPush(id, { inputSchema?, branch, message })`: defaults `runner` to `DEFAULT_NODE_RUNNER_AST_NODE`, binds optional `inputSchema` (inferring `TIn` across `branch` and `message` callbacks without manual `z.infer` annotations), and persists `inFlightCommitAndPush = { preStepHeadSha, preStepBaseRef, targetBranch }` in `harness-meta.json` before squashing over `baseRef`, rebasing according to `reconcileStrategy`, running `git push --force-with-lease`, and updating `rootHandle` lineage in place; on any rebase/push failure or crash recovery (`reattachRoot`), executes `git rebase --abort` (if in progress), `git reset --hard <preStepHeadSha>`, restores `baseRef = preStepBaseRef`, and clears `inFlightCommitAndPush`.
- `git.mergeQueue(id, { targetBranch, maxBatchSize, verifyWith })` & `.reconcileStrategy('batch-merge-train')`: constructs a cumulative speculative rebase chain $R_1, \dots, R_k$ (up to `maxBatchSize`), runs `verifyWith` once on the tip $R_k$, fast-forwards `targetBranch` if $R_k$ passes, and binary-bisects $R_1 \dots R_k$ on verification failure to isolate and evict the offending candidate branch while landing valid prefixes.

---

## 5. Deterministic Test Suite Architecture (`packages/git/test/**`)

All `test/fixtures/**` files strictly obey single-entity-kind file separation, single responsibility at one level of abstraction, and complete §2 JSDoc:

| File Path | Primary Category | Required Deterministic Test Cases |
| :--- | :--- | :--- |
| `test/fixtures/temp-git-host-repo-handle.ts` | `fixture (interface)` | Dedicated single-`interface` file (`TempGitHostRepoHandle`) exposing `hostRepoPath`, `remoteRepoPath`, `baseSha`, and `cleanup()` for temporary Git test repositories. |
| `test/fixtures/temp-git-host-repo.ts` | `fixture (function)` | Single-`function` helper (`createTempGitHostRepo`) creating real local Git repositories (and local bare `origin` remotes) with multi-partition files and commits. |
| `test/git-checkpoints-and-integrity.test.ts` | `test` | Verifies `git.ScopeReceiptSchema` / `SyncReceiptSchema` / `AbortMetaSchema` namespace mounting, `GitCowWorktreeBuilder` fluent methods (`.excludeFromCloneGlobs`, `.setup`, `.lockfileGate` hash hit vs gate miss unlinking/replacing hardlinked `node_modules`, `.checkpointPolicy`, `.reconcileStrategy`, default `conflictCleanCheck`), `acquireRoot`, `serializeCheckpoint`, `diffEffects`, and 4-step `restoreCheckpoint` across tracked edits, untracked files, deletions, symlinks, `.gitignore` manipulation, oversized untracked blobs, and worktree-local `.git` / `node_modules` tampering rollback. |
| `test/git-worktree-reconcile-and-conflicts.test.ts` | `test` | Verifies `forkChild` (including automatic parent dirty-tree flush), non-mutating `inspect` and host ref pinning (`refs/harness/candidates/<run-id>/<branch-index>`, `refs/harness/completed/roots/<run-id>`, `refs/harness/completed/forks/<run-id>/<fork-id>`), clean & conflicted `commitChild` (verifying `parent` is untouched on conflict, `child.unresolvedConflictPaths` is populated, `getConflictLease` returns `{ type: 'harness:lease-delta', id, grantedMatchers: [...] }` granting write access to conflicted paths, and `conflictCleanCheck` blocks until resolved), `syncChild`, `syncRoot`, and `reattachRoot`/`reattachChild` crash recovery. |
| `test/git-hooks-tools-and-commit-push.test.ts` | `test` | Verifies `git.snapshotAndReset()` (`refs/harness/aborted/...` idempotency), `git.keepWorktree()`, `git.resetWorktree()`, `git.refReaderTools`, `git.candidateComparisonTools` (verifying `evalInCandidates` restores candidate checkpoint), `git.publicSurfaceCrossTester` and `git.patchEquivalence` (`CrossVerifierBuilder` `.id`, `.reportSchema`, `.toAST()`, and execution), `git.commitAndPush` (including `inFlightCommitAndPush` failure/crash rollback restoring `preStepHeadSha` and `preStepBaseRef`), and `git.mergeQueue` / `.reconcileStrategy('batch-merge-train')` cumulative rebase chain $R_1 \dots R_k$ with single `verifyWith` on $R_k$ and binary bisection on failure. |

---

## 6. Verification Gate Commands

Run from workspace root (plus the `IMPL_LOOP.md` `baseline_dirty` diff check against `<non_sibling_forbidden_dirs_excluding_upstream_patches>`):

```bash
pnpm --filter @paraharness/git lint
pnpm --filter @paraharness/git typecheck
pnpm --filter @paraharness/git test -- --reporter=verbose
test -z "$(git status --porcelain -- docs .agents .claude package.json tsconfig.base.json vitest.config.ts)"
```
