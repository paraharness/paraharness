# Milestone 3d (`M3d`): `@harness-dsl/git` CoW Worktrees, Git-Index Checkpoints & Stateless Reconciliation

## 1. Scope & Package Directory

- **Milestone Wave:** Parallel Wave 2 — Scoped Adapter Builder (`c`) (Depends on Wave 1a `M1` -> Wave 1b `M2` completing)
- **Owned Files & Directories:**
  - `packages/git/src/types.ts`
  - `packages/git/src/git-exec.ts`
  - `packages/git/src/cow-clone.ts`
  - `packages/git/src/checkpoints.ts`
  - `packages/git/src/merge-reconcile.ts`
  - `packages/git/src/cow-worktree.ts`
  - `packages/git/src/commit-and-push.ts`
  - `packages/git/src/hooks-and-tools.ts`
  - `packages/git/src/cross-tester.ts`
  - `packages/git/src/index.ts`
  - `packages/git/test/cow-worktree-clone.test.ts`
  - `packages/git/test/checkpoints-integrity.test.ts`
  - `packages/git/test/merge-reconcile.test.ts`
  - `packages/git/test/commit-push-tools.test.ts`
- **Forbidden Directories:**
  - Do not modify root workspace files (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `pnpm-lock.yaml`) or `packages/core/**`.
  - Do not touch `packages/sqlite`, `packages/postgres`, `packages/fs`, `packages/markdown`, `packages/node`, `packages/claude`, `packages/openai`, `packages/github`, `packages/slack`, `packages/stripe`, `packages/netsuite`, or `packages/integration`.
  - Zero cross-adapter imports: `packages/git` imports only from `@harness-dsl/core`, `picomatch`, `zod`, and Node.js built-ins (`node:child_process`, `node:crypto`, `node:fs`, `node:os`, `node:path`).

---

## 2. Exact Spec Grounding Table

Read the following sections in full before authoring any file in `M3d`:

| Document | Section | Line Range | Key Contracts & Git/Worktree Semantics Covered |
| :--- | :--- | :--- | :--- |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §1.1 Package Boundaries | `18` | `@harness-dsl/git` responsibilities and isolation invariants |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §2.2 `AbortHook`, `ScopeRewindHook` & §2.4 `IsolationScope`, `CheckpointableScope`, `BranchableScope`, `CrossVerifier` | `135–147, 223–305` | Tier-1, Tier-2, and Tier-3 scope contracts and `ReconcileResult<TData>` |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §3.7.2 Per-Handle Scope Locks, `.fork()`, `.speculate()`, `.mutatePlan()`, `resumeFork` | `1088–1277` | `ScopeLockManager` caller contract vs internal per-`parentHandle` async flush mutex on `forkChild`; `commitChild`, `syncChild`, `syncRoot` |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §4.4 `@harness-dsl/git` | `1401–1464` | `ScopeReceiptSchema`, `SyncReceiptSchema`, `AbortMetaSchema`, `git.cowWorktree`, `<gitdir>/harness-meta.json`, `serializeCheckpoint` / `diffEffects` / 4-step `restoreCheckpoint`, `inspect`, stateless `git merge-tree --write-tree` over `-p $C_0`, `conflictCleanCheck`, `release`, `reconcileStrategy`, `snapshotAndReset`, `keepWorktree`, `resetWorktree`, `publicSurfaceCrossTester`, `refReaderTools`, `candidateComparisonTools`, `commitAndPush` |
| [`docs/CODING_SAMPLE.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_SAMPLE.md) | §3.2 Hierarchical CoW Worktree Scope & §6 `engineering-harness.ts` | `116–127, 492–530, 715–718, 854, 909, 987–1001` | Production `workspace` builder chain, `crossTester`, `refReaderTools`, `candidateComparisonTools`, `landChanges` |

---

## 3. File-by-File Architecture & Exported Symbols

### 3.1 `packages/git/src/types.ts` & `packages/git/src/index.ts`

```ts
import { z } from 'zod';
import type {
  AbortHook,
  BranchableScope,
  Check,
  CheckpointableScope,
  CrossVerifier,
  EnvRef,
  PartitionGlobEntry,
  PartitionMap,
  ScopeRewindHook,
  StepExecutable,
  ToolDefinition,
} from '@harness-dsl/core';

export type { PartitionGlobEntry, PartitionMap };

export const ScopeReceiptSchema = z.object({
  headRef: z.string(),
  baseRef: z.string(),
  branchName: z.string().optional(),
  baseBranch: z.string().default('main'),
  diffStat: z.string(),
  mutatedFiles: z.array(z.string()),
});
export type GitScopeReceipt = z.infer<typeof ScopeReceiptSchema>;

export const SyncReceiptSchema = z.object({
  rebasedOntoRef: z.string(),
  baseBranch: z.string().default('main'),
  updatedFiles: z.array(z.string()),
});
export type GitSyncReceipt = z.infer<typeof SyncReceiptSchema>;

export const AbortMetaSchema = z.object({
  abortedSnapshotRef: z.string(),
  resetToRef: z.string(),
});
export type GitAbortMeta = z.infer<typeof AbortMetaSchema>;

export interface HarnessWorktreeMeta {
  baseRef: string;
  baseBranch: string;
  branchName?: string;
  unresolvedConflictPaths: string[];
  conflictRecordedHashes?: Record<string, string>;
  pendingParentHeadSha?: string;
  inFlightCommitAndPush?: {
    readonly preStepHeadSha: string;
    readonly preStepBaseRef: string;
  };
}

export interface GitWorktreeHandle {
  readonly kind: 'git:worktree-handle';
  readonly id: string;
  readonly runId: string;
  readonly forkId?: string;
  readonly branchIndex?: number;
  readonly worktreePath: string;
  readonly gitDir: string;
  readonly hostRepoPath: string;
  headRef: string;
  baseRef: string;
  baseBranch: string;
  branchName?: string;
  unresolvedConflictPaths: string[];
  readonly env: Readonly<Record<string, string>>;
}

export type PartitionMapLike = Pick<
  PartitionMap<string>,
  'kind' | 'topologyId' | 'partitions'
>;

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

export interface CowWorktreeBuilder
  extends BranchableScope<GitWorktreeHandle, GitScopeReceipt, GitSyncReceipt>,
    CheckpointableScope<GitWorktreeHandle, GitScopeReceipt> {
  excludeFromCloneGlobs(globs: readonly string[]): CowWorktreeBuilder;
  setup(command: StepExecutable<any, any, any>): CowWorktreeBuilder;
  lockfileGate(lockfilePath: string): CowWorktreeBuilder;
  checkpointPolicy(opts: {
    readonly partitionMap?: PartitionMapLike;
    readonly excludeGlobs?: readonly string[];
    readonly maxUntrackedFileSizeBytes?: number;
  }): CowWorktreeBuilder;
  reconcileStrategy(
    strategy: 'rebase-onto-base' | 'batch-merge-train',
    opts?: {
      readonly verifyWith?: Check<any>;
      readonly maxBatchSize?: number;
    },
  ): CowWorktreeBuilder;
}

export interface CommitAndPushBuilder<TIn = any> extends StepExecutable<TIn, void, GitWorktreeHandle> {
  input<TSchema extends z.ZodTypeAny>(schema: TSchema): CommitAndPushBuilder<z.infer<TSchema>>;
  runner(runner: RunnerLike): CommitAndPushBuilder<TIn>;
  env(vars: Readonly<Record<string, string | EnvRef>>): CommitAndPushBuilder<TIn>;
}

export const CrossTestReportSchema = z.object({
  branchIndex: z.number(),
  passedCrossTests: z.array(z.string()),
  failedCrossTests: z.array(
    z.object({
      fromBranchIndex: z.number(),
      testFile: z.string(),
      errorOutput: z.string(),
    }),
  ),
});
export type CrossTestReport = z.infer<typeof CrossTestReportSchema>;

export const git: {
  readonly ScopeReceiptSchema: typeof ScopeReceiptSchema;
  readonly SyncReceiptSchema: typeof SyncReceiptSchema;
  readonly AbortMetaSchema: typeof AbortMetaSchema;
  cowWorktree(opts: { readonly repo: string; readonly dir: string }): CowWorktreeBuilder;
  snapshotAndReset(): AbortHook<GitWorktreeHandle, GitAbortMeta>;
  keepWorktree(): ScopeRewindHook<GitWorktreeHandle>;
  resetWorktree(): ScopeRewindHook<GitWorktreeHandle>;
  publicSurfaceCrossTester(opts: {
    readonly runner: RunnerLike;
    readonly partitionMap: PartitionMapLike;
  }): CrossVerifier<GitWorktreeHandle, GitScopeReceipt, CrossTestReport>;
  refReaderTools(runner?: RunnerLike): readonly ToolDefinition<GitWorktreeHandle>[];
  candidateComparisonTools(runner?: RunnerLike): readonly ToolDefinition<GitWorktreeHandle>[];
  commitAndPush<TIn = any>(
    id: string,
    opts: {
      readonly branch: (input: TIn) => string;
      readonly message: (input: TIn) => string;
    },
  ): CommitAndPushBuilder<TIn>;
};
```

---

## 4. Critical Implementation Invariants

1. **Disjoint Worktree Layout, CoW/Hardlink Cloning, Environment Isolation & `reattachRoot`/`reattachChild` (`SPEC.md` §4.4 lines 1430–1439):**
   - Root worktrees reside at `<dir>/roots/<runId>` and fork worktrees at `<dir>/forks/<runId>/<forkId>`. When `repo: '.'`, `<dir>/**`, `.harness/state.sqlite*`, and `.harness/lesson*` are implicitly excluded from all clones and checkpoints.
   - Registers every worktree via `git worktree add --detach` with `<gitdir>/harness-meta.json`.
   - Clones dirty working-tree files and `**/node_modules` using `cp -c` (APFS) or `cp --reflink=always` (Btrfs/XFS); on Linux `ext4` fallback, dirty files use `cp -a` (copy by value) while `**/node_modules` preserves workspace symlinks (`cp -P`), hardlinks regular package files (`cp -al`) **without** `chmod a-w`, and copies `**/node_modules/.prisma/**` by value. If `.lockfileGate(lockfilePath)` misses, unlinks the hardlinked `node_modules` tree before running `.setup(...)`.
   - Injects `GIT_CEILING_DIRECTORIES=<path.dirname(worktreePath)>`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_OPTIONAL_LOCKS=0`, `GIT_CONFIG_COUNT=2`, `GIT_CONFIG_KEY_0=commit.gpgsign`, `GIT_CONFIG_VALUE_0=false`, `GIT_CONFIG_KEY_1=core.hooksPath`, `GIT_CONFIG_VALUE_1=/dev/null`.
   - `reattachRoot` / `reattachChild`: if `pendingParentHeadSha` is set in `harness-meta.json`, executes `git update-ref HEAD <pendingParentHeadSha>` and clears `pendingParentHeadSha` before any flush; if `inFlightCommitAndPush` is set, runs `git rebase --abort` (if in progress), `git reset --hard <preStepHeadSha>`, restores `baseRef = preStepBaseRef`, and clears `inFlightCommitAndPush`; otherwise preserves an intact worktree directory on disk as-is.
2. **Hardened Checkpoints (`serializeCheckpoint`, `diffEffects`, 4-Step `restoreCheckpoint`) (`SPEC.md` §4.4 lines 1440–1444):**
   - `serializeCheckpoint(handle)` records `{ headSha, headRawContent, indexTreeSha, meta, statusMap, treeSha, oversizedUntrackedBlobs }` using `git status --porcelain=v2 -z --no-renames --untracked-files=all` (always tracking `.gitignore`), `${mode}:${sha256}` hashes (`lstat` + `readlink` for symlinks), `<gitdir>/harness-ckpt-blobs/` for untracked (`?`) files $> \text{maxUntrackedFileSizeBytes}$, and a temporary `GIT_INDEX_FILE` (`git read-tree <headSha>`, `git update-index --add --stdin -z` for all tracked modified/added files plus untracked $\le \text{maxUntrackedFileSizeBytes}$, `git update-index --force-remove --stdin -z` for tracked deletions, `git write-tree`).
   - `diffEffects(fromCheckpoint, handle)` verifies `<gitdir>/HEAD` raw content, `git rev-parse HEAD`, `indexTreeSha`, `<gitdir>/harness-meta.json`, and `**/node_modules/**` integrity first (calling `restoreCheckpoint` and throwing a non-leasable scope integrity error on tampering), then returns `FsToolEffect` for the symmetric difference between `fromCheckpoint.statusMap` and `currentStatusMap`.
   - `restoreCheckpoint(handle, fromCheckpoint)` executes in strict 4-step order: (1) restore `<gitdir>/HEAD`, `<gitdir>/harness-meta.json`, `handle` metadata, and reset `<gitdir>/index` to `fromCheckpoint.headSha` to compute `currentStatusMap`; (2) unlink every path in `symDiff` absent from both `treeSha` and `oversizedUntrackedBlobs` (and `rm -rf` any path in `symDiff` present as a file/symlink in `treeSha` or `oversizedUntrackedBlobs` that is currently a directory on disk via `lstat`), pruning empty parent directories; (3) populate `<tmpIndex>` via `git read-tree <fromCheckpoint.treeSha>` and run `git checkout-index -f -z --stdin` for `symDiff` paths in `treeSha` (falling back to `-a` if integrity failed), then restore live `<gitdir>/index` to `fromCheckpoint.indexTreeSha`; (4) `fs.mkdir(dirname, { recursive: true })` and copy back `oversizedUntrackedBlobs`.
3. **Automatic Parent Flush, Speculative `forkId` Candidate Registry, Side-Effect-Free `inspect()`, Stateless `git merge-tree --write-tree` (`commitChild`, `syncChild`, `syncRoot`) & `conflictCleanCheck` (`SPEC.md` §4.4 lines 1445–1453):**
   - Automatic Parent Working-Tree Flush before `forkChild`, `syncChild`, or `commitChild` commits non-excluded dirty files not in `parentHandle.unresolvedConflictPaths` onto `parentHandle.HEAD` while keeping `parentHandle.baseRef` pinned (`forkChild` guards this with an internal per-`parentHandle` async mutex).
   - When `parentHandle.unresolvedConflictPaths` is non-empty during `forkChild(parentHandle, forkId)`, `forkChild` does not auto-commit the conflicted paths onto `parentHandle.HEAD`; instead, it copies the dirty conflicted files from `parentHandle.worktreePath` into `childHandle.worktreePath`, copies `parentHandle.unresolvedConflictPaths` (and `conflictRecordedHashes`) into `childHandle.unresolvedConflictPaths`, and arms `conflictCheckArmed = true` on the child (`SPEC.md` §4.4 line 1436).
   - `forkChild(parentHandle, forkId)` parses `/branch-(\d+)$/` from `forkId` (`"speculate-${callId}-branch-${branchIndex}"`) to set `childHandle.branchIndex = Number(match[1])` and registers active candidate handles in an in-memory map keyed by `${runId}:${branchIndex}` (removing the entry in `release(handle)`) so `inspect(handle)` and `candidateComparisonTools` (`evalInCandidates`, `diffCandidates`, `readCandidateFile`) resolve live candidate worktrees deterministically.
   - `inspect(handle)` never mutates live `.git/index` or `HEAD`, pins `refs/harness/candidates/<run-id>/<branch-index>` when `handle.branchIndex !== undefined`, and computes `diffStat` and `mutatedFiles` against `handle.baseRef`.
   - `commitChild`, `syncChild`, and `syncRoot` synthesize commits over `-p $C_0$` (`$C_1' = \text{git commit-tree } C_1^{\text{tree}} -p\ C_0$` and `$C_{\text{child}} = \text{git commit-tree } T_{\text{child}} -p\ C_0$`) and run `git merge-tree --write-tree`:
     - Before merging in `commitChild`, if `childHandle.unresolvedConflictPaths` remains non-empty or `conflictCleanCheck` fails on `childHandle`, `commitChild` returns `{ status: 'conflict', conflictedSummary, conflictedPaths: [...childHandle.unresolvedConflictPaths] }` immediately without mutating `parent` or re-merging (`SPEC.md` §4.4 line 1447).
     - Clean `commitChild`: keeps `child.baseRef = C_0` untouched, resets any path in `parentHandle.unresolvedConflictPaths` modified/added/deleted by `$C_{\text{target}}$` in `parent` to match `$C_1$` before `git read-tree -u -m $C_1 $C_{\text{target}}`, persists `pendingParentHeadSha: $C_{\text{target}}$` before updating the working tree, updates `parent.HEAD`, and clears `pendingParentHeadSha` and any paths in `parentHandle.unresolvedConflictPaths` resolved by the child (`SPEC.md` §4.4 line 1448).
     - Conflicted `commitChild`, and all `syncChild` / `syncRoot` materializations: reset target `HEAD` and `.git/index` to `$C_1$`, set `baseRef = C_1`, materialize `$T_{\text{merged}}$` via `GIT_INDEX_FILE=<tmpIndex> git read-tree $T_{\text{merged}}$` + `git checkout-index -f -a`, unlink paths in `$C_0 \cup T_{\text{current}}$` absent from `$T_{\text{merged}}$`, record all conflicted paths—including Modify/Delete, Add/Add, Binary, and text-marker content conflicts—in `unresolvedConflictPaths` (plus `conflictRecordedHashes`), and return `conflictedPaths: [...targetHandle.unresolvedConflictPaths]` on the `'conflict'` `ReconcileResult` variant (`SPEC.md` §2.4 lines 226–235, §4.4 lines 1448–1452).
   - `conflictCleanCheck` scans dirty/untracked files and `git diff <baseRef> HEAD` for paired `^<{7} ` / `^={7}( |$)` / `^>{7} ` marker blocks (ignoring standalone Markdown `=======`) and verifies every path in `unresolvedConflictPaths` has been modified or unlinked since the conflict was recorded.
   - `release(handle)` removes `${runId}:${branchIndex}` from the live candidate registry (if present) and pins `refs/harness/completed/roots/<run-id>` or `refs/harness/completed/forks/<run-id>/<fork-id>` before `git worktree remove --force`.
4. **`commitAndPush`, `snapshotAndReset`, `keepWorktree`, `resetWorktree`, `candidateComparisonTools` & `refReaderTools` (`SPEC.md` §2.2 line 144, §4.4 lines 1428, 1457–1463):**
   - `commitAndPush` auto-flushes dirty working-tree changes onto `rootHandle.HEAD` (`preStepHeadSha`) and persists `inFlightCommitAndPush: { preStepHeadSha, preStepBaseRef }`. When `rootHandle.baseBranch !== 'main'`, it fetches `origin` and checks whether `origin/${rootHandle.baseBranch}` still exists: if `origin/${rootHandle.baseBranch}` was deleted after squash-merging into `origin/main`, it falls back to `resolvedBaseBranch = 'main'`; if `origin/${rootHandle.baseBranch}` was closed/deleted on remote **without** merging its changes into `origin/main`, it throws an unmerged-prerequisite error and rolls back to `preStepHeadSha` and `preStepBaseRef` (`SPEC.md` §4.4 line 1463). Otherwise it wraps squash + rebase (`git rebase --onto origin/${resolvedBaseBranch} <rootHandle.baseRef> HEAD`) + `verifyWith` + `git push --force-with-lease` in a `try/catch` that aborts rebase and resets to `preStepHeadSha` / `preStepBaseRef` on failure, updates `rootHandle` (`baseRef = rev-parse(origin/${resolvedBaseBranch})`, `baseBranch = resolvedBaseBranch`, `branchName`, `headRef = pushedCommitSha`), and clears `inFlightCommitAndPush` on success.
   - `git.keepWorktree()` is a no-op `ScopeRewindHook` that preserves the worktree's current commits and dirty working-tree files across a rewind; `git.resetWorktree()` is a `ScopeRewindHook` that cleans dirty/untracked working-tree files and resets `HEAD` (and `.git/index`) to `targetCheckpoint` (or `handle.baseRef` when `targetCheckpoint` is empty) and clears `unresolvedConflictPaths`.
   - `evalInCandidates` in `candidateComparisonTools` resolves live candidate handles from the in-memory `${runId}:${branchIndex}` registry and wraps every candidate benchmark command in `const ckpt = await serializeCheckpoint(candidateHandle)` + `try/finally { await restoreCheckpoint(candidateHandle, ckpt) }`.

---

## 5. Required Test Suite (`packages/git/test/*.test.ts`)

1. **`cow-worktree-clone.test.ts`:**
   - Disjoint `<dir>/roots/<runId>` and `<dir>/forks/<runId>/<forkId>` layout, `GIT_CEILING_DIRECTORIES` and `GIT_CONFIG_*` environment isolation, `.excludeFromCloneGlobs()`, `.lockfileGate()` hit vs miss (unlinking hardlinked `node_modules` before `.setup()`), and `reattachRoot` recovering `pendingParentHeadSha` and `inFlightCommitAndPush`.
2. **`checkpoints-integrity.test.ts`:**
   - `serializeCheckpoint`, `diffEffects`, and 4-step `restoreCheckpoint` across tracked modifications, tracked deletions (`--force-remove`), untracked files, oversized untracked blobs (`> 1MB`), symlink changes (`lstat` + `readlink`), file-to-directory replacement in `symDiff` (`rm -rf` before `checkout-index`), and `.gitignore` tracking.
   - Worktree-local `.git` tampering detection (`<gitdir>/HEAD`, `indexTreeSha`, `harness-meta.json`) and `**/node_modules/**` write detection triggering immediate rollback and non-leasable integrity error.
3. **`merge-reconcile.test.ts`:**
   - Concurrent `forkChild` calls with dirty `parentHandle` serialized by the internal per-`parentHandle` flush mutex, and `forkId = "speculate-${callId}-branch-${branchIndex}"` setting `childHandle.branchIndex` and populating the live candidate registry.
   - `forkChild` and `commitChild` when `parentHandle.unresolvedConflictPaths` is non-empty: verifying `forkChild` copies dirty conflicted files + `unresolvedConflictPaths` into `childHandle` without committing conflict markers to `parent.HEAD`, `commitChild` returns `status: 'conflict'` immediately without mutating `parent` if `childHandle.unresolvedConflictPaths` is unedited, and clean `commitChild` after resolving the conflict updates `parent` and clears resolved paths from `parentHandle.unresolvedConflictPaths`.
   - Side-effect-free `inspect()` leaving `.git/index` and `HEAD` untouched while pinning `refs/harness/candidates/<run-id>/<branch-index>`.
   - Stateless `commitChild` (clean fast-forward, clean 3-way merge when `parent.HEAD` advanced, conflicted 3-way merge leaving `parent` untouched and materializing $T_{\text{merged}}$ + `unresolvedConflictPaths` + `conflictedPaths` into `child`), `syncChild`, and `syncRoot` (including unlinking files deleted upstream in $C_0 \cup T_{\text{current}}$ absent from $T_{\text{merged}}$, and recording Modify/Delete, Add/Add, and Binary conflicts in `unresolvedConflictPaths` and `ReconcileResult.conflictedPaths`).
   - `conflictCleanCheck` detecting paired conflict markers while allowing standalone Markdown `=======` lines, and requiring `unresolvedConflictPaths` (including Modify/Delete, Add/Add, and Binary conflicts) to be resolved.
4. **`commit-push-tools.test.ts`:**
   - `git.commitAndPush` with `rebase-onto-base` against a local bare remote (`origin`), squash-merged prerequisite `baseBranch` fallback to `'main'`, throwing and rolling back to `preStepHeadSha` / `preStepBaseRef` when `baseBranch !== 'main'` was closed on remote without merging into `origin/main`, `try/catch` rollback to `preStepHeadSha` on `verifyWith` or push failure, and `batch-merge-train` bisection.
   - `git.snapshotAndReset` idempotency on `refs/harness/aborted/<run-id>/<stepExecId>`, plus `git.keepWorktree()` (preserving dirty/committed worktree state) vs `git.resetWorktree()` (cleaning dirty state and resetting `HEAD` to `targetCheckpoint` / `baseRef`).
   - `git.refReaderTools`, `git.candidateComparisonTools` (`evalInCandidates` resolving live candidates by `branchIndex` and rolling back via `try/finally` checkpoint restore), and `git.publicSurfaceCrossTester`.

---

## 6. Verification Gate Commands

```bash
pnpm check:comments
pnpm --filter @harness-dsl/git typecheck
pnpm --filter @harness-dsl/git test
```
