# Milestone M3d — `@harness-dsl/git` CoW Worktree Scope, Git-Index Checkpoints & Stateless 3-Way Reconciliation

## 1. Scope & Ownership (`owned_dirs` & `forbidden_dirs`)

- **Milestone**: `M3d` (Wave 2 — Parallel Adapter Fan-Out `c`, depends on `M1`)
- **Package**: `@harness-dsl/git` (`packages/git`)
- **`owned_dirs`**:
  - `packages/git/src/**`
  - `packages/git/test/**`
- **`forbidden_dirs`**:
  - `packages/core/**`
  - `packages/{sqlite,postgres,fs,markdown,node,claude,openai,gemini,github,slack,stripe,netsuite,integration}/**`
  - Root workspace configs (`package.json`, `eslint.config.mjs`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`) and `docs/**`
- **Cross-Adapter Independence Rule**:
  - `@harness-dsl/git` must have **zero runtime or type imports** from any other M3 adapter package. It depends exclusively on `@harness-dsl/core` (`workspace:*`), `picomatch`, `zod`, and Node built-ins (`node:child_process`, `node:fs`, `node:fs/promises`, `node:path`, `node:crypto`).

---

## 2. Normative Specification & Coding Sample Grounding

| Normative Source | Section & Exact Line Range | Grounded Scope in `M3d` |
| :--- | :--- | :--- |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §1.1–§1.2 (`lines 3–34`) | Pure passive AST nodes (`GitWorktreeHandle`, `GitScopeReceipt`, `GitSyncReceipt`, `GitAbortMeta`, `GitCleanWorkingTreeNode`, `GitCowWorktreeNode`, `GitCommitAndPushNode`, `GitMergeQueueNode`, `GitSnapshotAndResetNode`, `GitKeepWorktreeNode`, `GitDiscardBranchNode`, `GitPatchEquivalenceNode`, `GitPublicSurfaceCrossTesterNode`, `GitRefReaderToolNode`, `GitCandidateComparisonToolNode`) and zero I/O at builder time. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §2.2–§2.5 (`lines 682–1505`) | `BaseIsolationScopeASTNode` (`capabilityTier: 'branchable'`), `BaseDomainStepASTNode`, `BaseCheckASTNode`, `BaseToolASTNode`, `BaseAbortHookASTNode`, `BaseScopeRewindHookASTNode`, `BaseCrossVerifierASTNode`, `IsolationScope`, `CheckpointableScope`, `BranchableScope` (`getConflictLease`), `ReconcileResult`, `RuntimeExecutorRegistrySlice`. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §3.5, §3.7.2, §3.9, §3.10 (`lines 2286–2616`) | Post-flight subprocess sandboxing (`serializeCheckpoint`, `diffEffects`, `restoreCheckpoint`), downward `.fork()` and `.speculate()` worktree reconciliation (`commitChild`, `syncChild`, `syncRoot`, `reattachRoot`, `reattachChild`), `git.snapshotAndReset()`, and `git.keepWorktree()` / `git.resetWorktree()`. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §4.4 (`lines 2899–3083`) | Complete `@harness-dsl/git` specification: `git.ScopeReceiptSchema`, `git.SyncReceiptSchema`, `git.AbortMetaSchema`, `git.cowWorktree({ repo, dir })` (`<dir>/roots/<runId>` & `<dir>/forks/<runId>/<forkId>`, `<gitdir>/harness-meta.json`, `unresolvedConflictPaths`, `getConflictLease`, automatic parent working-tree flush, `GIT_CEILING_DIRECTORIES`, `reattachRoot` / `reattachChild`, `--porcelain=v2 -z --no-renames --untracked-files=all` checkpoints, worktree-local `.git` integrity in `diffEffects`, 4-step `restoreCheckpoint`, non-mutating `inspect`, stateless `git merge-tree --write-tree` in `commitChild` / `syncChild` / `syncRoot`, `reconcileStrategy`), `git.snapshotAndReset()`, `git.keepWorktree()`, `git.resetWorktree()`, `git.discardBranch()`, `git.publicSurfaceCrossTester`, `git.patchEquivalence`, `git.refReaderTools`, `git.candidateComparisonTools`, `git.commitAndPush`, `git.mergeQueue`. |
| [`docs/CODING_SAMPLE.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_SAMPLE.md) | §3.2 (`lines 116–127`), §4 (`lines 130–141`), §5 (`lines 144–173`), §6 (`lines 182, 492–530, 681, 692, 715–718, 750, 780, 786, 854, 909, 990–1000, 1051, 1077, 1095, 1189`) | Git-Index Checkpoint Sandboxing (`§3.2`), Two-Temperature Persistence (`§4`), Truth-Maintenance Protocols (`§5`), and all `git.*` invocations in `engineering-harness.ts`. |

---

## 3. Planned Module Decomposition & Public Exports (`packages/git/src/**`)

Every file in `packages/git/src/**` and `packages/git/test/fixtures/**` adheres to [`docs/CODING_GUIDELINES.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_GUIDELINES.md) §1–§5 (`<= 250` lines per file, zero co-location of `interface` / `function` / `class` / `const` / `type`, strictly 1 top-level `interface` per file plus `TSPropertySignature` property sub-interfaces only, 1 `class` per file, 1 builder factory function per `create-*.ts` file, `internal/` helpers, pure `src/index.ts` barrel, full 3-part `/** ... */` JSDoc on every declaration and `TSMethodSignature`, and zero inline/non-JSDoc comments).

| File Path | Primary Category | Exported Symbols |
| :--- | :--- | :--- |
| `src/schemas/git-receipts.schema.ts` | `schema` | `GitScopeReceiptSchema`, `GitSyncReceiptSchema`, `GitAbortMetaSchema`, `HarnessMetaSchema`, `HarnessMetaRecord` |
| `src/builders/git-cow-worktree-options.ts` | `interface` | `GitCowWorktreeOptions` |
| `src/builders/git-reconcile-strategy-options.ts` | `interface` | `GitReconcileStrategyOptions` |
| `src/builders/git-cow-worktree-builder.ts` | `interface` | `GitCowWorktreeBuilder` |
| `src/builders/create-git-cow-worktree-builder.ts` | `function` | `createGitCowWorktreeBuilder` |
| `src/builders/git-commit-and-push-options.ts` | `interface` | `GitCommitAndPushOptions<TIn>` |
| `src/builders/git-commit-and-push-builder.ts` | `interface` | `GitCommitAndPushBuilder<TIn>` |
| `src/builders/create-git-commit-and-push-builder.ts` | `function` | `createGitCommitAndPushBuilder` |
| `src/builders/git-merge-queue-options.ts` | `interface` | `GitMergeQueueOptions` |
| `src/builders/git-merge-queue-builder.ts` | `interface` | `GitMergeQueueBuilder<TIn, TOut>` |
| `src/builders/create-git-merge-queue-builder.ts` | `function` | `createGitMergeQueueBuilder` |
| `src/builders/git-public-surface-cross-tester-options.ts` | `interface` | `GitPublicSurfaceCrossTesterOptions` |
| `src/builders/create-git-snapshot-and-reset-builder.ts` | `function` | `createGitSnapshotAndResetBuilder` |
| `src/builders/create-git-keep-worktree-builder.ts` | `function` | `createGitKeepWorktreeBuilder` |
| `src/builders/create-git-reset-worktree-builder.ts` | `function` | `createGitResetWorktreeBuilder` |
| `src/builders/create-git-discard-branch-builder.ts` | `function` | `createGitDiscardBranchBuilder` |
| `src/builders/create-git-public-surface-cross-tester-builder.ts` | `function` | `createGitPublicSurfaceCrossTesterBuilder` |
| `src/builders/create-git-patch-equivalence-builder.ts` | `function` | `createGitPatchEquivalenceBuilder` |
| `src/builders/create-git-ref-reader-tools.ts` | `function` | `createGitRefReaderTools` |
| `src/builders/create-git-candidate-comparison-tools.ts` | `function` | `createGitCandidateComparisonTools` |
| `src/builders/git-namespace-contract.ts` | `interface` | `GitNamespace` |
| `src/builders/git-namespace.ts` | `const` | `git: GitNamespace` (mounting `ScopeReceiptSchema`, `SyncReceiptSchema`, `AbortMetaSchema`, and all `git.*` builders) |
| `src/executors/git-checkpoint-payload.ts` | `interface` | `GitCheckpointPayload` |
| `src/executors/internal/git-cli-runner.ts` | `function` | `runGitCommand`, `buildIsolatedWorktreeGitEnv`, `readHarnessMeta`, `writeHarnessMeta` |
| `src/executors/internal/porcelain-v2-and-checkpoints.ts` | `function` | `computeWorktreeStatusMap`, `serializeGitWorktreeCheckpoint`, `diffGitWorktreeEffects`, `restoreGitWorktreeCheckpoint` |
| `src/executors/internal/conflict-pruning-and-parent-flush.ts` | `function` | `pruneResolvedConflictPaths`, `hasPairedConflictMarkers`, `flushParentWorkingTreeCleanChanges`, `buildConflictLeaseDelta` |
| `src/executors/internal/stateless-merge-tree-reconcile.ts` | `function` | `inspectGitWorktreeNonMutating`, `commitChildViaMergeTree`, `syncChildViaMergeTree`, `syncRootViaMergeTree` |
| `src/executors/internal/worktree-clone-and-reattach.ts` | `function` | `acquireRootWorktree`, `forkChildWorktree`, `reattachRootWorktree`, `reattachChildWorktree`, `releaseWorktreeAndPinRef` |
| `src/executors/git-cow-worktree-scope.ts` | `class` | `GitCowWorktreeScopeDriver` (implementing `BranchableScope<GitWorktreeHandle, GitScopeReceipt, GitSyncReceipt>`) |
| `src/executors/git-commit-and-merge-steps.ts` | `function` | `executeGitCommitAndPushStep`, `executeGitMergeQueueStep` |
| `src/executors/git-hooks-and-checks.ts` | `function` | `executeGitCleanWorkingTreeCheck`, `executeGitSnapshotAndResetHook`, `executeGitKeepWorktreeHook`, `executeGitDiscardBranchHook` |
| `src/executors/git-cross-verifiers-and-tools.ts` | `function` | `executeGitPublicSurfaceCrossTester`, `executeGitPatchEquivalence`, `createGitRefReaderToolDrivers`, `createGitCandidateComparisonToolDrivers` |
| `src/executors/create-git-executors.ts` | `function` | `createGitExecutors` |
| `src/executors/git-executors.constants.ts` | `const` | `gitExecutors: RuntimeExecutorRegistrySlice` |
| `src/index.ts` | `barrel` | Pure explicit re-exports of `git`, `GitNamespace`, `gitExecutors`, `createGitExecutors`, `GitCowWorktreeScopeDriver`, `GitScopeReceiptSchema`, `GitSyncReceiptSchema`, `GitAbortMetaSchema`, `HarnessMetaSchema`, `HarnessMetaRecord`, `GitCowWorktreeBuilder`, `GitCowWorktreeOptions`, `GitReconcileStrategyOptions`, `GitCommitAndPushBuilder`, `GitCommitAndPushOptions`, `GitMergeQueueBuilder`, `GitMergeQueueOptions`, `GitPublicSurfaceCrossTesterOptions`, all `createGit*` builder factories, and all `Git*` AST types from `@harness-dsl/core` |

---

## 4. Detailed Implementation Requirements

### 4.0 Strict File Separation & Full 3-Part JSDoc (`docs/CODING_GUIDELINES.md` §§1–2)
1. **Zero Co-Location of Entity Kinds**:
   - `interface`, `function`, `class`, `const`, and `type` declarations must **never** live in the same file in `packages/git/src/**` or `packages/git/test/fixtures/**` (sole exception: `src/schemas/git-receipts.schema.ts` pairing Zod schemas with their `z.infer` types).
   - Every builder interface (`*-builder.ts`), options/payload interface (`*-options.ts`, `git-checkpoint-payload.ts`), and namespace contract (`git-namespace-contract.ts`) gets its own single-interface file; every builder factory function (`create-*.ts`) gets its own single-function file; `GitCowWorktreeScopeDriver` gets its own single-class file; `git` and `gitExecutors` live in their own `const`-only files.
2. **Full 3-Part JSDoc Requirement**:
   - Every `interface`, `class`, `function`, class method, **interface method signature (`TSMethodSignature`)**, `type`, and exported `const` in `src/**` and `test/fixtures/**` must carry full 3-part JSDoc per `docs/CODING_GUIDELINES.md` §2 (2-paragraph Summary + Detailed description separated by a blank `*` line, vertically aligned `@template` and `@param {Type} name - Description`, and `@returns {Type} Description`), enforced by `pnpm --filter @harness-dsl/git lint`.

### 4.1 `GitNamespace`, `GitCowWorktreeBuilder`, Disjoint Worktree Layout & Crash Reattachment (`SPEC.md` §4.4 lines 3049–3058)
1. **`GitNamespace` & `GitCowWorktreeBuilder` Fluent Contract**:
   - Mounts `ScopeReceiptSchema`, `SyncReceiptSchema`, and `AbortMetaSchema` directly on the `git` namespace (`git.ScopeReceiptSchema`, `git.SyncReceiptSchema`, `git.AbortMetaSchema`) alongside all `git.*` builder factories.
   - `git.cowWorktree({ repo, dir })` returns `GitCowWorktreeBuilder` exposing `.excludeFromCloneGlobs(globs)`, `.setup(cmd)`, `.lockfileGate(lockfilePath)`, `.checkpointPolicy(policy)`, `.reconcileStrategy(mode, opts?)` (supporting `(mode: 'rebase-onto-base' | 'batch-merge-train', opts?: { verifyWith?: MaybeBuilder<CheckASTNode<GitWorktreeHandle>>; maxBatchSize?: number })` as well as a single-object overload), and `.toAST(): GitCowWorktreeNode` (populating default `conflictCleanCheck: { type: 'git:clean-working-tree', id: 'git-clean-working-tree' }`, `receiptSchema: git.ScopeReceiptSchema`, and `syncSchema: git.SyncReceiptSchema`).
2. **Disjoint Sibling Directories & `.lockfileGate` / `.setup` CoW Hydration**:
   - Task root worktrees live at `<dir>/roots/<runId>` and child fork worktrees at `<dir>/forks/<runId>/<forkId>` via `git worktree add --detach`, with isolated `<hostRepo>/.git/worktrees/<worktreeId>/harness-meta.json` storing `{ baseRef, baseBranch, branchName, unresolvedConflictPaths, pendingParentHeadSha?, inFlightMerge?, inFlightCommitAndPush? }`.
   - When `.lockfileGate(lockfilePath)` (e.g., `'pnpm-lock.yaml'`) and `.setup(cmd)` are configured, computes the SHA-256 digest of `lockfilePath` against the host repo's cached lockfile hash: on a cache hit, hardlinks/CoW-clones `node_modules` (excluding `.excludeFromCloneGlobs`); on a gate miss (when `lockfilePath` differs), unlinks/replaces any hardlinked `node_modules` directory before running `.setup(cmd)` so dependency installation never mutates shared host inodes.
   - Injects `GIT_CEILING_DIRECTORIES=<path.dirname(worktreePath)>`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_OPTIONAL_LOCKS=0`, `GIT_CONFIG_COUNT=2`, `GIT_CONFIG_KEY_0=commit.gpgsign`, `GIT_CONFIG_VALUE_0=false`, `GIT_CONFIG_KEY_1=core.hooksPath`, and `GIT_CONFIG_VALUE_1=/dev/null`.
3. **Automatic Conflict Pruning, `getConflictLease(handle)` & Automatic Parent Flush (`SPEC.md` §4.4 line 3055)**:
   - `getConflictLease(handle)` returns `{ type: 'harness:lease-delta', id, grantedMatchers: [{ type: 'fs:match-globs', id: matcherId, globs: Object.keys(handle.unresolvedConflictPaths), mode: 'write' }] }` when `unresolvedConflictPaths` is non-empty (without importing `@harness-dsl/fs`).
   - Prunes any path in `unresolvedConflictPaths` whose working-tree `${mode}:${sha256}` differs from its recorded conflict-time digest (or was unlinked) and contains no paired conflict markers (`^<{7} ` ... `^={7}( |$)` ... `^>{7} `).
   - Auto-commits non-conflicted dirty working-tree files on `parentHandle` onto `parentHandle.HEAD` before `forkChild` (guarded by an internal per-`parentHandle` async mutex), `syncChild`, or `commitChild` while keeping `parentHandle.baseRef` pinned.
4. **Crash Reattachment (`reattachRoot` / `reattachChild`)**:
   - Completes interrupted `pendingParentHeadSha`, `inFlightMerge`, or rolls back `inFlightCommitAndPush` on reboot without losing uncommitted working-tree edits.

### 4.2 Hardened Git-Index Checkpoints (`serializeCheckpoint`, `diffEffects`, `restoreCheckpoint`, `SPEC.md` §4.4 lines 3059–3063)
- `serializeCheckpoint(handle)` captures `{ headSha, headRawContent, indexTreeSha, infoExcludeContent, meta, statusMap, treeSha, oversizedUntrackedBlobs }` using `git status --porcelain=v2 -z --no-renames --untracked-files=all` and a temporary `GIT_INDEX_FILE`.
- `diffEffects(fromCheckpoint, handle)` verifies worktree-local `.git` integrity (`HEAD`, `indexTreeSha`, `info/exclude`, `harness-meta.json`) and `**/node_modules/**` untampered state (immediately calling `restoreCheckpoint` and throwing a non-leasable scope integrity error if tampered), checks `--ignored=matching` when any `**/.gitignore` changed, and emits the symmetric difference between `fromCheckpoint.statusMap` and `currentStatusMap` as `FsToolEffect`.
- `restoreCheckpoint(handle, fromCheckpoint)` executes the 4-step restoration protocol (`HEAD`/`info/exclude`/`harness-meta.json`/`.gitignore` restore $\to$ `symDiff` unlink $\to$ `<tmpIndex> git read-tree` + `checkout-index` $\to$ `oversizedUntrackedBlobs` restore).

### 4.3 Non-Mutating `inspect`, Host Ref Pinning & Stateless `git merge-tree --write-tree` Reconciliation (`SPEC.md` §4.4 lines 3064–3075)
- `inspect(handle)` uses a temporary `GIT_INDEX_FILE` to write a commit object over `handle.baseRef` without mutating the live worktree `HEAD` or `.git/index`, and pins the resulting commit SHA under `refs/harness/candidates/<run-id>/<branch-index>` on the host repository when inspecting speculative candidate branches.
- `release(handle)` pins the final commit SHA under `refs/harness/completed/roots/<run-id>` (for root worktrees) or `refs/harness/completed/forks/<run-id>/<fork-id>` (for child fork worktrees) on the host repository before removing the worktree directory (`git worktree remove --force`).
- `commitChild(child, parent)`, `syncChild(parent, pausedChild)`, and `syncRoot(rootHandle, prereqReceipts)` synthesize commits sharing $C_0 = \text{baseRef}$ as their sole immediate parent and run `git merge-tree --write-tree`, materializing conflicts cleanly into the child/root working tree via `inFlightMerge` + `checkout-index -f -a` with zero `.git/rebase-merge` state and recording `unresolvedConflictPaths`.

### 4.4 Hooks, `CrossVerifierBuilder`, Tools, `git.commitAndPush` & `git.mergeQueue` (`SPEC.md` §4.4 lines 3076–3083)
- `git.snapshotAndReset()` idempotently snapshots the working tree over `handle.baseRef` to `refs/harness/aborted/<run-id>/<stepExecId>`, resets to `handle.baseRef`, and clears `unresolvedConflictPaths`.
- `git.keepWorktree()` (`resetsRunOverlay: false`) and `git.resetWorktree()` / `git.discardBranch()` (`resetsRunOverlay: true`).
- `git.publicSurfaceCrossTester({ runner, partitionMap })` and `git.patchEquivalence(...)` return `CrossVerifierBuilder` instances exposing `.id`, `.reportSchema`, and `.toAST()` (`GitPublicSurfaceCrossTesterNode` and `GitPatchEquivalenceNode`), with executors `executeGitPublicSurfaceCrossTester` and `executeGitPatchEquivalence`.
- `git.refReaderTools(runner)` (`readRefFile`, `diffRefs`, `listRefFiles`) and `git.candidateComparisonTools(runner)` (`diffCandidates`, `readCandidateFile`, `evalInCandidates` wrapping candidate benchmark runs in `serializeCheckpoint` + `try/finally { restoreCheckpoint }`).
- `git.commitAndPush(id, { branch, message })`: persists `inFlightCommitAndPush = { preStepHeadSha, preStepBaseRef, targetBranch }` in `harness-meta.json` before squashing over `baseRef`, rebasing according to `reconcileStrategy`, running `git push --force-with-lease`, and updating `rootHandle` lineage in place; on any rebase/push failure or crash recovery (`reattachRoot`), executes `git rebase --abort` (if in progress), `git reset --hard <preStepHeadSha>`, restores `baseRef = preStepBaseRef`, and clears `inFlightCommitAndPush`.
- `git.mergeQueue(id, { targetBranch, maxBatchSize, verifyWith })` & `.reconcileStrategy('batch-merge-train')`: constructs a cumulative speculative rebase chain $R_1, \dots, R_k$ (up to `maxBatchSize`), runs `verifyWith` once on the tip $R_k$, fast-forwards `targetBranch` if $R_k$ passes, and binary-bisects $R_1 \dots R_k$ on verification failure to isolate and evict the offending candidate branch while landing valid prefixes.

---

## 5. Deterministic Test Suite Architecture (`packages/git/test/**`)

All `test/fixtures/**` files strictly obey single-entity-kind file separation (`<= 250` lines per file, full 3-part §2 JSDoc):

| File Path | Line Ceiling | Required Deterministic Test Cases |
| :--- | :--- | :--- |
| `test/fixtures/temp-git-host-repo.ts` | `<= 250` | Pure `function` helper creating real local Git repositories (and local bare `origin` remotes) with multi-partition files and commits (any fixture handle `interface` lives in its own `temp-git-host-repo-handle.ts` file). |
| `test/git-checkpoints-and-integrity.test.ts` | `<= 400` | Verifies `git.ScopeReceiptSchema` / `SyncReceiptSchema` / `AbortMetaSchema` namespace mounting, `GitCowWorktreeBuilder` fluent methods (`.excludeFromCloneGlobs`, `.setup`, `.lockfileGate` hash hit vs gate miss unlinking/replacing hardlinked `node_modules`, `.checkpointPolicy`, `.reconcileStrategy`, default `conflictCleanCheck`), `acquireRoot`, `serializeCheckpoint`, `diffEffects`, and 4-step `restoreCheckpoint` across tracked edits, untracked files, deletions, symlinks, `.gitignore` manipulation, oversized untracked blobs, and worktree-local `.git` / `node_modules` tampering rollback. |
| `test/git-worktree-reconcile-and-conflicts.test.ts` | `<= 400` | Verifies `forkChild` (including automatic parent dirty-tree flush), non-mutating `inspect` and host ref pinning (`refs/harness/candidates/<run-id>/<branch-index>`, `refs/harness/completed/roots/<run-id>`, `refs/harness/completed/forks/<run-id>/<fork-id>`), clean & conflicted `commitChild` (verifying `parent` is untouched on conflict, `child.unresolvedConflictPaths` is populated, `getConflictLease` returns `{ type: 'harness:lease-delta', id, grantedMatchers: [...] }` granting write access to conflicted paths, and `conflictCleanCheck` blocks until resolved), `syncChild`, `syncRoot`, and `reattachRoot`/`reattachChild` crash recovery. |
| `test/git-hooks-tools-and-commit-push.test.ts` | `<= 400` | Verifies `git.snapshotAndReset()` (`refs/harness/aborted/...` idempotency), `git.keepWorktree()`, `git.resetWorktree()`, `git.refReaderTools`, `git.candidateComparisonTools` (verifying `evalInCandidates` restores candidate checkpoint), `git.publicSurfaceCrossTester` and `git.patchEquivalence` (`CrossVerifierBuilder` `.id`, `.reportSchema`, `.toAST()`, and execution), `git.commitAndPush` (including `inFlightCommitAndPush` failure/crash rollback restoring `preStepHeadSha` and `preStepBaseRef`), and `git.mergeQueue` / `.reconcileStrategy('batch-merge-train')` cumulative rebase chain $R_1 \dots R_k$ with single `verifyWith` on $R_k$ and binary bisection on failure. |

---

## 6. Verification Gate Commands

Run from workspace root (plus the `IMPL_LOOP.md` `baseline_dirty` diff check against `<non_sibling_forbidden_dirs_excluding_upstream_patches>`):

```bash
pnpm --filter @harness-dsl/git lint
pnpm --filter @harness-dsl/git typecheck
pnpm --filter @harness-dsl/git test -- --reporter=verbose
test -z "$(git status --porcelain -- docs .agents .claude package.json tsconfig.base.json vitest.config.ts)"
```
