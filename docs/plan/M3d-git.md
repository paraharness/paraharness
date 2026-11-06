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
  - Root workspace configs (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`) and `docs/**`
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
| [`docs/CODING_SAMPLE.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_SAMPLE.md) | §4 (`lines 130–141`), §5 (`lines 144–173`), §6 (`lines 182, 492–530, 681, 692, 715–718, 750, 780, 786, 854, 909, 990–1000, 1051, 1077, 1095, 1189`) | All `git.*` invocations in `engineering-harness.ts`. |

---

## 3. Planned Module Decomposition & Public Exports (`packages/git/src/**`)

Every file in `packages/git/src/**` and `packages/git/test/fixtures/**` adheres to [`docs/CODING_GUIDELINES.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_GUIDELINES.md) §1–§5 (`<= 250` lines per file, single primary concept per file, `internal/` helpers, pure `src/index.ts` barrel, complete `/** ... */` JSDoc, and zero inline/non-JSDoc comments).

| File Path | Primary Category | Exported Symbols |
| :--- | :--- | :--- |
| `src/schemas/git-receipts.schema.ts` | `schema` | `GitScopeReceiptSchema`, `GitSyncReceiptSchema`, `GitAbortMetaSchema`, `HarnessMetaSchema`, `HarnessMetaRecord` |
| `src/builders/git-cow-worktree-builder.ts` | `interface` | `GitCowWorktreeBuilder`, `createGitCowWorktreeBuilder` |
| `src/builders/git-commit-and-queue-builders.ts` | `interface` | `GitCommitAndPushBuilder`, `createGitCommitAndPushBuilder`, `createGitMergeQueueBuilder` |
| `src/builders/git-hooks-verifiers-and-tools.ts` | `function` | `createGitSnapshotAndResetBuilder`, `createGitKeepWorktreeBuilder`, `createGitDiscardBranchBuilder`, `createGitPublicSurfaceCrossTesterBuilder`, `createGitPatchEquivalenceBuilder`, `createGitRefReaderTools`, `createGitCandidateComparisonTools` |
| `src/builders/git-namespace.constants.ts` | `const` | `git`, `GitNamespace` |
| `src/executors/internal/git-cli-runner.ts` | `function` | `runGitCommand`, `buildIsolatedWorktreeGitEnv`, `readHarnessMeta`, `writeHarnessMeta` |
| `src/executors/internal/porcelain-v2-and-checkpoints.ts` | `function` | `computeWorktreeStatusMap`, `serializeGitWorktreeCheckpoint`, `diffGitWorktreeEffects`, `restoreGitWorktreeCheckpoint` |
| `src/executors/internal/conflict-pruning-and-parent-flush.ts` | `function` | `pruneResolvedConflictPaths`, `hasPairedConflictMarkers`, `flushParentWorkingTreeCleanChanges`, `buildConflictLeaseDelta` |
| `src/executors/internal/stateless-merge-tree-reconcile.ts` | `function` | `inspectGitWorktreeNonMutating`, `commitChildViaMergeTree`, `syncChildViaMergeTree`, `syncRootViaMergeTree` |
| `src/executors/internal/worktree-clone-and-reattach.ts` | `function` | `acquireRootWorktree`, `forkChildWorktree`, `reattachRootWorktree`, `reattachChildWorktree`, `releaseWorktreeAndPinRef` |
| `src/executors/git-cow-worktree-scope.ts` | `class` | `GitCowWorktreeScopeDriver` (implementing `BranchableScope<GitWorktreeHandle, GitScopeReceipt, GitSyncReceipt>`) |
| `src/executors/git-commit-and-merge-steps.ts` | `function` | `executeGitCommitAndPushStep`, `executeGitMergeQueueStep` |
| `src/executors/git-hooks-and-checks.ts` | `function` | `executeGitCleanWorkingTreeCheck`, `executeGitSnapshotAndResetHook`, `executeGitKeepWorktreeHook`, `executeGitDiscardBranchHook` |
| `src/executors/git-cross-verifiers-and-tools.ts` | `function` | `executeGitPublicSurfaceCrossTester`, `executeGitPatchEquivalence`, `createGitRefReaderToolDrivers`, `createGitCandidateComparisonToolDrivers` |
| `src/executors/git-executors.constants.ts` | `const` | `gitExecutors: RuntimeExecutorRegistrySlice`, `createGitExecutors` |
| `src/index.ts` | `barrel` | Pure explicit re-exports of `git`, `gitExecutors`, `createGitExecutors`, `GitCowWorktreeScopeDriver`, `GitScopeReceiptSchema`, `GitSyncReceiptSchema`, `GitAbortMetaSchema`, `GitCowWorktreeBuilder`, `GitCommitAndPushBuilder`, and all `Git*` AST types from `@harness-dsl/core` |

---

## 4. Detailed Implementation Requirements

### 4.1 Disjoint Worktree Layout, `<gitdir>/harness-meta.json` & Crash Reattachment (`SPEC.md` §4.4 lines 3049–3058)
1. **Disjoint Sibling Directories**:
   - Task root worktrees live at `<dir>/roots/<runId>` and child fork worktrees at `<dir>/forks/<runId>/<forkId>` via `git worktree add --detach`, with isolated `<hostRepo>/.git/worktrees/<worktreeId>/harness-meta.json` storing `{ baseRef, baseBranch, branchName, unresolvedConflictPaths, pendingParentHeadSha?, inFlightMerge?, inFlightCommitAndPush? }`.
   - Injects `GIT_CEILING_DIRECTORIES=<path.dirname(worktreePath)>`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_OPTIONAL_LOCKS=0`, `commit.gpgsign=false`, and `core.hooksPath=/dev/null`.
2. **Automatic Conflict Pruning, `getConflictLease(handle)` & Automatic Parent Flush (`SPEC.md` §4.4 line 3055)**:
   - `getConflictLease(handle)` returns `{ type: 'harness:lease-delta', matcher: { type: 'fs:match-globs', globs: Object.keys(handle.unresolvedConflictPaths), mode: 'write' } }` when `unresolvedConflictPaths` is non-empty (without importing `@harness-dsl/fs`).
   - Prunes any path in `unresolvedConflictPaths` whose working-tree `${mode}:${sha256}` differs from its recorded conflict-time digest (or was unlinked) and contains no paired conflict markers (`^<{7} ` ... `^={7}( |$)` ... `^>{7} `).
   - Auto-commits non-conflicted dirty working-tree files on `parentHandle` onto `parentHandle.HEAD` before `forkChild` (guarded by an internal per-`parentHandle` async mutex), `syncChild`, or `commitChild` while keeping `parentHandle.baseRef` pinned.
3. **Crash Reattachment (`reattachRoot` / `reattachChild`)**:
   - Completes interrupted `pendingParentHeadSha`, `inFlightMerge`, or rolls back `inFlightCommitAndPush` on reboot without losing uncommitted working-tree edits.

### 4.2 Hardened Git-Index Checkpoints (`serializeCheckpoint`, `diffEffects`, `restoreCheckpoint`, `SPEC.md` §4.4 lines 3059–3063)
- `serializeCheckpoint(handle)` captures `{ headSha, headRawContent, indexTreeSha, infoExcludeContent, meta, statusMap, treeSha, oversizedUntrackedBlobs }` using `git status --porcelain=v2 -z --no-renames --untracked-files=all` and a temporary `GIT_INDEX_FILE`.
- `diffEffects(fromCheckpoint, handle)` verifies worktree-local `.git` integrity (`HEAD`, `indexTreeSha`, `info/exclude`, `harness-meta.json`) and `**/node_modules/**` untampered state (immediately calling `restoreCheckpoint` and throwing a non-leasable scope integrity error if tampered), checks `--ignored=matching` when any `**/.gitignore` changed, and emits the symmetric difference between `fromCheckpoint.statusMap` and `currentStatusMap` as `FsToolEffect`.
- `restoreCheckpoint(handle, fromCheckpoint)` executes the 4-step restoration protocol (`HEAD`/`info/exclude`/`harness-meta.json`/`.gitignore` restore $\to$ `symDiff` unlink $\to$ `<tmpIndex> git read-tree` + `checkout-index` $\to$ `oversizedUntrackedBlobs` restore).

### 4.3 Non-Mutating `inspect` & Stateless `git merge-tree --write-tree` Reconciliation (`SPEC.md` §4.4 lines 3064–3075)
- `inspect(handle)` uses a temporary `GIT_INDEX_FILE` to write a commit object over `handle.baseRef` without mutating the live worktree `HEAD` or `.git/index`.
- `commitChild(child, parent)`, `syncChild(parent, pausedChild)`, and `syncRoot(rootHandle, prereqReceipts)` synthesize commits sharing $C_0 = \text{baseRef}$ as their sole immediate parent and run `git merge-tree --write-tree`, materializing conflicts cleanly into the child/root working tree via `inFlightMerge` + `checkout-index -f -a` with zero `.git/rebase-merge` state and recording `unresolvedConflictPaths`.

### 4.4 Hooks, Cross-Verifiers, Tools & `git.commitAndPush` (`SPEC.md` §4.4 lines 3076–3083)
- `git.snapshotAndReset()` idempotently snapshots the working tree over `handle.baseRef` to `refs/harness/aborted/<run-id>/<stepExecId>`, resets to `handle.baseRef`, and clears `unresolvedConflictPaths`.
- `git.keepWorktree()` (`resetsRunOverlay: false`) and `git.resetWorktree()` / `git.discardBranch()` (`resetsRunOverlay: true`).
- `git.publicSurfaceCrossTester({ runner, partitionMap })` and `git.patchEquivalence(...)`.
- `git.refReaderTools(runner)` (`readRefFile`, `diffRefs`, `listRefFiles`) and `git.candidateComparisonTools(runner)` (`diffCandidates`, `readCandidateFile`, `evalInCandidates` wrapping candidate benchmark runs in `serializeCheckpoint` + `try/finally { restoreCheckpoint }`).
- `git.commitAndPush(id, { branch, message })` with `inFlightCommitAndPush` crash-rollback protection, squash over `baseRef`, `reconcileStrategy` rebase, `git push --force-with-lease`, and in-place `rootHandle` lineage update.

---

## 5. Deterministic Test Suite Architecture (`packages/git/test/**`)

| File Path | Line Ceiling | Required Deterministic Test Cases |
| :--- | :--- | :--- |
| `test/fixtures/temp-git-host-repo.ts` | `<= 250` | Creates real local Git repositories (and local bare `origin` remotes) with multi-partition files and commits. |
| `test/git-checkpoints-and-integrity.test.ts` | `<= 400` | Verifies `acquireRoot`, `serializeCheckpoint`, `diffEffects`, and 4-step `restoreCheckpoint` across tracked edits, untracked files, deletions, symlinks, `.gitignore` manipulation, oversized untracked blobs, and worktree-local `.git` / `node_modules` tampering rollback. |
| `test/git-worktree-reconcile-and-conflicts.test.ts` | `<= 400` | Verifies `forkChild` (including automatic parent dirty-tree flush), non-mutating `inspect`, clean & conflicted `commitChild` (verifying `parent` is untouched on conflict, `child.unresolvedConflictPaths` is populated, `getConflictLease` grants write access to conflicted paths, and `conflictCleanCheck` blocks until resolved), `syncChild`, `syncRoot`, and `reattachRoot`/`reattachChild` crash recovery. |
| `test/git-hooks-tools-and-commit-push.test.ts` | `<= 400` | Verifies `git.snapshotAndReset()` (`refs/harness/aborted/...` idempotency), `git.keepWorktree()`, `git.resetWorktree()`, `git.refReaderTools`, `git.candidateComparisonTools` (verifying `evalInCandidates` restores candidate checkpoint), `git.publicSurfaceCrossTester`, and `git.commitAndPush` against a real local bare `origin` remote. |

---

## 6. Verification Gate Commands

Run from workspace root:

```bash
pnpm --filter @harness-dsl/git typecheck
pnpm --filter @harness-dsl/git test -- --reporter=verbose
test -z "$(git status --porcelain -- packages/core packages/sqlite packages/postgres packages/fs packages/markdown packages/node packages/claude packages/openai packages/gemini packages/github packages/slack packages/stripe packages/netsuite packages/integration)"
```
