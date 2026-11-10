# Coding Workflow Application Harness Specification (acme-engineering V7)

# 1. System Overview & Architectural Objectives

The **Coding Workflow Application Harness** (`acme-engineering`) is a production software engineering system built by composing `@paraharness/core` with its domain adapter packages (`@paraharness/claude`, `@paraharness/fs`, `@paraharness/git`, `@paraharness/github`, `@paraharness/markdown`, `@paraharness/node`, `@paraharness/slack`, `@paraharness/sqlite`).

All OS subprocess management (`local.command`, `local.streamCheck`, `local.daemon`), filesystem guards and glob matchers (`fs.*`), and Copy-on-Write git worktree isolation (`git.*`) are supplied by peer packages whose fluent builders (`AstBuilder<TNode>`) emit pure passive discriminated-union AST nodes (`DomainASTNode` with `readonly type: '...'`) dispatched at runtime by `@paraharness/core` via `RuntimeExecutorRegistry`.

The harness enforces five operational invariants across software engineering tasks:

1. **Evaluated Fast-Path for Small Tasks:** Untriaged tasks (`routingTier: 'auto'`) start in `verifiedWorkerLoop.withPolicy(fastPathPolicy)` governed by quantitative tripwires (`fs.maxFilesMutated(4)`, `maxTurns(8)`, `maxCostUsd(1.0)`). Small bug fixes complete in a single loop iteration, pass both `verifySuite` and adversarial `evaluator` review, and open a pull request without `coordinator` overhead.
2. **Lossless Reconnaissance Promotion for Secretly Large Tasks:** When an untriaged task breaches a fast-path tripwire or voluntarily raises `contractViolation`, the harness guarantees idempotent scope cleanup via `git.snapshotAndReset()` (bound on both `workerBasePolicy.onAbort()` and `.replaceWith()` edges) to save the dirty worktree over `handle.baseRef` to `refs/harness/aborted/<run-id>/<stepExecId>` and reset the worktree to clean `handle.baseRef`, then promotes execution to the long-horizon `coordinator` seeded with the fast-path file-access trace (`telemetry.custom.filesRead`), the aborted git ref (`telemetry.abortMeta.abortedSnapshotRef`), and `git.refReaderTools(runner)` so the coordinator can directly inspect and diff the aborted attempt.
3. **Single-Mind Coherence with Role-Scoped KV-Cached Downward Forking & Reboot-Safe Continuation Stacks:** `coordinator`, `worker`/`guardedWorker`, and `evaluator` share a compiled `P.prefixGroup` (`engineeringPrefix`) configured with `.toolsMode('role-scoped')` and pinned in AST declaration order at run start (`PRODUCT_SPEC.md`, `TECH_DESIGN.md`, `base-posture.md`, global rules, with JSON-serializable `wireToolSchemasByRoleKey[roleKey]` and `groundingSnapshots`). Each role (and `.withTools()` clone) transmits its own role-scoped wire `tools` array alongside the shared `system` prompt—so `sonnet` workers achieve a 100% prefix cache hit across all `sonnet` worker invocations without prefilling or seeing `coordinator`-only orchestration tools (`delegate-partition`, `explore-candidates`, `spawnTasks`, `resumeFork`). Run-scoped CoW partition contracts and epochs (`repoTopology`), worktree-aware in-run grounding diffs (e.g., if `coordinator` edits `TECH_DESIGN.md`), role-specific instructions (`worker.md`), the catalog of mounted skills (`(skillId, description)`), and partition-scoped rules are injected into the Turn-0 `[ROLE_AND_SCOPE_CONTEXT]` user frame so in-run topology or grounding updates never bust byte 0 of the wire system prompt or leak across concurrent unmerged runs. Downward forks (`delegate-partition`) default to `historyMode: 'shared-prefix-only'`, starting a clean child transcript right after the cached prefix while persisting tree-structured `ContinuationFrame[]` stacks (serialized through a per-step async queue, including `'fork-batch-frame'`, `'speculate-frame'`, loop-scoped `grantedLoopLeases`, `.act()`-scoped `activeSkillIds`/`activeSkillActivations`, `observedEffects`, `injectedScopedRuleIds`, cumulative telemetry counters, and deduplicated 4-state `accumulatedLessonOutcomes`) across `P.loop` (`guardedWorker` + `evaluator`, automatically quiescing active `'skill'` daemons at step boundaries) and reconciling via idempotent stateless 3-way `git merge-tree --write-tree` conflict-bouncing `commitChild`.
4. **Separation-of-Duties Test & Boundary Ratchet with Chained Policy Clauses, Post-Flight Verified Test Runs & Declaration-Ordered Tool Replay:** Workers mount `verifySuite.asTool()` so they can run tests and typechecks mid-session before attempting completion (preventing blind first-attempt `beforeStop` failures from poisoning `repoLessons` with false `gate_rejected_recovered` outcomes). Because `verifySuite.asTool()` executes arbitrary test code, its compiled `LocalStreamCheckToolNode` declares `effectTracking: 'subprocess-post-flight'` (and omits static `ToolDriver.describeEffects`), forcing `git.cowWorktree.diffEffects()` to deterministically verify worktree-local `.git` metadata integrity (`<gitdir>/HEAD`, `git rev-parse HEAD`, `indexTreeSha`, `<gitdir>/info/exclude`, and `<gitdir>/harness-meta.json`) and compute the symmetric difference of `git status --porcelain=v2 -z --no-renames` and `${mode}:${sha256}` hashes so that any test run (or timed-out/killed subprocess) attempting to mutate a protected boundary (`packages/*/src/index.ts`), existing test (`**/*.test.ts`, `**/*.test.tsx`), `.gitignore`, `.harness/**`, or spec file (`PRODUCT_SPEC.md`, `TECH_DESIGN.md`, `openapi.yaml`) is rolled back via `restoreCheckpoint` before recording effects. `workerBasePolicy` chains two guard clauses where all `'deny-with-error'` clauses are evaluated before any `'raise-interrupt'` clause: Clause 1 denies boundary, spec, `.gitignore`, and `.harness/**` writes in-band (`'deny-with-error'`, instructing the worker to raise `contractViolation`), while Clause 2 (`onlyExistingAtBaseRef: true`) allows creating *new* test files freely while intercepting edits/deletions to *existing* test files (`**/*.test.ts`, `**/*.test.tsx`) and raising a turn-batched `leaseRequest` to a read-only `leaseAdjudicator` agent; when approved, the granted `LeaseDelta` is recorded on both the active `agent-frame` and the enclosing `loop-frame` (`grantedLoopLeases`, persisting across loop iterations and cross-model escalations), and Core iterates `PendingToolBatch.remainingCalls` in strict `(1..k)` declaration order through the full per-call execution pipeline without burning an extra LLM generation turn.
5. **Single-Timeline Endogenous vs. Exogenous Truth Maintenance & Non-Destructive Contested Speculative Escalation Arbitration:**
    * **Endogenous Contract Violations (`contractViolation`):** When a forked child worker (or `evaluator`, which automatically rolls back to the write-capable worker frame at `preservedActLeafMessageId` while carrying `record.interruptPayloadJson` into `[CONTRACT_VIOLATION_RESOLVED]`) raises `contractViolation`, `.onChildInterrupt(contractViolation)` waits at the parent turn-batch barrier for all in-flight sibling turns to settle (canceling any pending sibling human requests and completing their trailing `role: 'tool'` frame), quiesces active `ServiceSession` daemons, suspends the raising fork (preserving its enclosing `verifiedWorkerLoop` frame on `continuationStack` with monotonic `suspendedForkId`), pauses any concurrent sibling forks in `repoTopology.affectedBy(v.partition)` across all sibling execution states (`TOOL_BOUNDARY` or neutral `BEFORE_STOP_GATE`), and returns `{ status: 'SUSPENDED_ON_INTERRUPT', suspendedForkId, ... }` as a normal `tool_result` to the coordinator's single continuous timeline. The coordinator updates the run-scoped contract epoch, edits boundary files (which `git.cowWorktree` automatically flushes onto `parent.HEAD` before fork/sync/commit), delegates any upstream implementation, and calls its native `resumeFork` tool to dirty-safely rebase (`syncChild`), resume the worker, and run the enclosing `verifiedWorkerLoop`'s `evaluator` step before committing. A built-in `beforeStop` gate (`parentStepExecId`) prevents `coordinator` from completing while any `SuspendedForkRecord` remains open.
    * **Exogenous Spec Updates & Non-Destructive Contested Speculative Escalation Arbitration (`normativeEscalation`):** Normative product trade-offs and mutations to `PRODUCT_SPEC.md` or `openapi.yaml` escalate via structured Decision Briefs (`normativeEscalation`) to the human `owner`. Inside speculative tournaments (`.speculate()`), any branch that triggers an exogenous `P.human` escalation or unhandled upward interrupt (`contractViolation`) is **parked** (`status: 'PARKED_ON_ESCALATION'`, quiescing its daemons and synthesizing its candidate commit ref via a non-mutating temporary git index) until all sibling branches finish. Whenever $\ge 1$ branch completes alongside $\ge 1$ parked branch, $\ge 2$ branches park, or after a prior human ruling in `humanRulingsHistory`, the tournament **never short-circuits arbitration**—it invokes `candidateArbiter` over the candidates. If `candidateArbiter` returns `decision: 'unpark-escalation'`, the tournament **retains all already-`COMPLETED` sibling branch handles alive**, pages the human owner (or returns `ABORTED_ON_CHILD_INTERRUPT` to `coordinator`'s timeline if `contractViolation` was selected), resumes the unparked branch to completion, and re-enters Post-Race Resolution (Cases 1–4) over the updated candidate set (including `humanRulingsHistory` and `failedBranches`) to either select the final winner (`'select-winner'`, keeping losing worktrees alive until after `refineWinnerWhen` and `commitChild` complete) or reject all candidates (`'reject-all'`).

---

# 2. Repository Layout & Knowledge Artifacts (`.harness/`)

All static prompts, versioned rules, pull-based skills, and content-addressed lesson definitions reside in `.harness/`, while high-frequency lesson telemetry counters, lockfiles, ephemeral CoW worktrees, and the local WAL ledger reside in git-ignored host paths:

~~~text
.harness/
├── bin/
│   └── cdp-repl.ts                     # Chrome DevTools Protocol REPL client for browserSandbox
├── prompts/
│   ├── base-posture.md                 # Shared epistemic posture across all agents (pinned in engineeringPrefix)
│   ├── worker.md                       # Implementation engineer instructions (injected at Turn-0 role frame)
│   ├── evaluator.md                    # Adversarial code & UI auditor instructions (injected at Turn-0 role frame)
│   ├── lease-adjudicator.md            # Test & boundary ratchet adjudicator instructions
│   ├── candidate-arbiter.md            # Pairwise speculative diff & contested escalation judge instructions
│   ├── coordinator.md                  # Long-horizon architect instructions (injected at Turn-0 role frame)
│   └── lesson-distiller.md             # Contrastive loop & beforeStop gate-recovery distiller instructions
├── rules/
│   ├── global/
│   │   ├── typescript-invariants.md    # Always-on global rule (cached in engineeringPrefix system block)
│   │   └── error-handling.md           # Always-on global rule (cached in engineeringPrefix system block)
│   ├── scoped/
│   │   └── web-accessibility.md        # Frontmatter-scoped rule for partition: web
│   ├── api-orm-boundary.md             # Code-scoped rule body paired with forbidDrizzleInApiCheck
│   └── db-migrations.md                # Hybrid frontmatter rule paired with forbidDropColumnCheck
├── skills/
│   ├── db-migrations/
│   │   └── SKILL.md                    # Frontmatter skill unlocking drizzleGenerate + localPostgres
│   ├── ui-verification/
│   │   └── instructions.md             # Code-scoped skill unlocking browserSandbox
│   └── shared/
│       └── perf-profiling.md           # Bulk-loaded procedural skill
├── lessons/                            # Host-root content-addressed lesson definitions (.json)
├── lesson-stats.json                   # Host-level mutable lesson outcome counters (git-ignored)
├── lessons.lock                        # Host-level lockfile for lesson store (git-ignored)
├── state.sqlite                        # Local WAL-mode ledger, topology store & owner rules (git-ignored)
└── workspaces/                         # Copy-on-Write git worktree pool (git-ignored)
~~~

## 2.1 Artifact Formats (`@paraharness/markdown` Frontmatter Contracts)

### Global Rule File (`.harness/rules/global/typescript-invariants.md`)

~~~markdown
---
id: strict-typescript-invariants
---
1. Never use `any` or `@ts-ignore` in production or test files.
2. All exported functions on partition boundary files (`src/index.ts`) must declare explicit parameter and return types.
~~~

### Scoped Rule File (`.harness/rules/db-migrations.md`)

~~~markdown
---
id: db-migration-safety
partitions:
  - db
globs:
  - packages/db/migrations/*.sql
  - packages/db/src/schema/**/*.ts
---
All schema changes must be backwards-compatible with the currently deployed N-1 API version. Never drop or rename an existing column without an approved two-phase migration plan.
~~~

### Pull-Based Skill File (`.harness/skills/db-migrations/SKILL.md`)

~~~markdown
---
id: db-migrations
description: Pull when modifying Drizzle table schemas, indexes, or generating/verifying SQL migrations.
partitions:
  - db
globs:
  - packages/db/**
---
1. Edit Drizzle table definitions in `packages/db/src/schema/`.
2. Invoke the unlocked `drizzle-generate` tool to generate the SQL migration file under `packages/db/migrations/`.
3. Use the unlocked `psql` interaction tool on the `local-pg` daemon service to apply the migration and verify index and constraint behavior.
4. Call `completeSkill({ skillId: "db-migrations" })` immediately after verification to stop and unmount `local-pg` (marking the skill instruction `callId` for cross-model fork tombstoning without mutating the active same-model KV cache).
~~~

---

# 3. Relational Topology, Filesystem Mapping & CoW Worktree Hierarchy

## 3.1 Relational Topology (`P.topology`) & Filesystem Partition Map (`fs.partitionMap`)

Logical partition relationships and contract epochs are tracked in `@paraharness/core` via `P.topology`, while `@paraharness/fs` maps each partition to physical file globs and protected boundary files:

| Partition | Member Globs (`globs`) | Protected Boundary Surface (`boundaryGlobs`) | Upstream Dependencies (`dependsOn`) | `repoTopology.affectedBy(p)` |
| :--- | :--- | :--- | :--- | :--- |
| **`db`** | `packages/db/**` | `packages/db/src/index.ts` | `[]` | `['db', 'api', 'web']` |
| **`api`** | `packages/api/**` | `packages/api/src/index.ts` | `['db']` | `['api', 'web']` |
| **`web`** | `packages/web/**` | `packages/web/src/index.ts` | `['api']` | `['web']` |

## 3.2 Hierarchical Copy-on-Write (CoW) Worktree Scope (`git.cowWorktree`)

`git.cowWorktree` compiles to `GitCowWorktreeNode` (`readonly type: 'git:cow-worktree'`, `readonly capabilityTier: 'branchable'`) and is backed at runtime by `BranchableScope` and `CheckpointableScope` (`RuntimeExecutorRegistry.scopes['git:cow-worktree']`) to manage a tree of CoW worktrees sharing the host repository's git object store:

1. **Disjoint Sibling Worktree Paths (`<dir>/roots/<runId>` & `<dir>/forks/<runId>/<forkId>`), Isolated `.git/worktrees/<id>` Metadata, `harness-meta.json` & Portable CoW/Hardlink File Tree:** Task root worktrees (`acquireRoot` / `reattachRoot`) and child fork worktrees (`forkChild` / `reattachChild`) are placed in disjoint sibling directories (`<dir>/roots/<runId>` and `<dir>/forks/<runId>/<forkId>`) so child worktrees never nest inside a parent worktree or pollute `git status`, `cp -c`, or `git clean` (implicitly excluding `<dir>/**`, `.harness/state.sqlite*`, and `.harness/lesson*` when `repo: '.'`). Every worktree is registered via `git worktree add --detach` so it receives an isolated `<hostRepo>/.git/worktrees/<worktreeId>` metadata directory (`HEAD`, `.git/index`, `index.lock`, and `harness-meta.json` persisting `{ baseRef, baseBranch, branchName, unresolvedConflictPaths, pendingParentHeadSha?, inFlightMerge?, inFlightCommitAndPush? }`, where `unresolvedConflictPaths` maps each conflicted path to its conflict-materialized `${mode}:${sha256}` digest (`Readonly<Record<string, string>>`, `'MISSING'` if absent on disk)) while sharing `<hostRepo>/.git/objects` and `refs`. `**/node_modules` plus dirty working-tree files are cloned via OS-level CoW (`cp -c` on APFS / `cp --reflink=always` on Btrfs/XFS); on Linux `ext4`, dirty working-tree files are copied by value (`cp -a` so agent edits never mutate parent inodes) while `**/node_modules` is cloned recursively (preserving workspace symlinks via `cp -P`, hardlinking package files via `cp -al` without mutating inode permissions via `chmod a-w`—since `cp -al` shares inodes with the host repository and global `pnpm` store, and writes to `**/node_modules/**` are instead denied by `fs.codingTools` and `diffEffects`—and copying `**/node_modules/.prisma/**` by value), with `GIT_CEILING_DIRECTORIES` set to `path.dirname(worktreePath)` (`<dir>/roots` or `<dir>/forks/<runId>`), `GIT_CONFIG_NOSYSTEM=1`, `GIT_OPTIONAL_LOCKS=0`, `GIT_CONFIG_COUNT=2`, `GIT_CONFIG_KEY_0=commit.gpgsign`, `GIT_CONFIG_VALUE_0=false`, `GIT_CONFIG_KEY_1=core.hooksPath`, and `GIT_CONFIG_VALUE_1=/dev/null`. `.excludeFromCloneGlobs(['dist/**', '.next/**', 'coverage/**', '**/*.tsbuildinfo', '.harness-ephemeral/**', '**/node_modules/.cache/**', '**/node_modules/.vite/**', '**/node_modules/.vitest/**'])` omits path-embedded incremental caches, while `.lockfileGate('pnpm-lock.yaml')` skips `pnpm install --frozen-lockfile` whenever the lockfile hash matches the warm `node_modules` tree (or unlinks/replaces the hardlinked `node_modules` tree before running `pnpm install` on a gate miss). On process restart, `reattachRoot` and `reattachChild` rebind intact worktree directories non-destructively (completing any `pendingParentHeadSha` `git update-ref HEAD`, finishing any interrupted `inFlightMerge`, or rolling back any `inFlightCommitAndPush` before preserving Turns `1..k` `edit_file` changes and restoring `pauseState.inFlightPreToolCheckpoint` if a subprocess crashed mid-call).
2. **Hardened `--no-renames` / `lstat` / `--force-remove` Git-Index Dirty Checkpoints & Worktree-Local `.git` Integrity (`serializeCheckpoint` / `restoreCheckpoint` / `diffEffects`):** Configured via `.checkpointPolicy({ partitionMap: repoPartitions, excludeGlobs: ['dist/**', '.next/**', 'coverage/**', '**/*.tsbuildinfo', '.harness-ephemeral/**', '**/node_modules/.cache/**', '**/node_modules/.vite/**', '**/node_modules/.vitest/**'], maxUntrackedFileSizeBytes: 1_048_576 })`. Before executing any tool with `effectTracking: 'subprocess-post-flight'` that omits static `ToolDriver.describeEffects` (such as `verifySuite.asTool()` or `drizzleGenerate.asTool()`), `git.cowWorktree` records `headSha` (`git rev-parse HEAD`), `<gitdir>/HEAD` raw content, `<gitdir>/info/exclude` content (`infoExcludeContent`), `meta`, and logical index tree OID (`indexTreeSha`), queries `git status --porcelain=v2 -z --no-renames --untracked-files=all` (always tracking `**/.gitignore`), hashes dirty/untracked files as `${mode}:${sha256}` (using `lstat` + `readlink` for symlinks), and snapshots the working state into a temporary git tree object via a temporary `GIT_INDEX_FILE` (`git read-tree <headSha>`, `git update-index --add` for **all** tracked modified/added files regardless of size plus untracked `?` files $\le$ `maxUntrackedFileSizeBytes`, `git update-index --force-remove` for tracked deletions, `git write-tree`; untracked `?` files exceeding `maxUntrackedFileSizeBytes` are copied into `<gitdir>/harness-ckpt-blobs/` via CoW or copy-by-value). Post-flight `diffEffects()` verifies worktree-local `.git` metadata integrity (`<gitdir>/HEAD` raw content, `git rev-parse HEAD`, `indexTreeSha`, `<gitdir>/info/exclude`, and `<gitdir>/harness-meta.json`—never global `git show-ref`, which concurrent worktrees legitimately mutate—immediately rolling back and throwing a non-leasable integrity error if `.git/**` or `**/node_modules/**` was tampered with), queries `currentStatusMap` (running with `--ignored=matching` and excluding only paths already ignored at `fromCheckpoint` or matching `excludeGlobs` whenever any `**/.gitignore` file was modified, added, or deleted relative to `fromCheckpoint.statusMap` so newly created untracked files hidden behind a `.gitignore` edit are included in `currentStatusMap` and `FsToolEffect.attributes.paths`), and computes the symmetric difference of the status/hash maps with zero kernel file-watcher races (`FSEvents`/`inotify`). In `restoreCheckpoint`, rollback executes in strict 4-step order: (1) restore `<gitdir>/HEAD` (`fromCheckpoint.headRawContent` + `fromCheckpoint.headSha`), `<gitdir>/info/exclude` (`fromCheckpoint.infoExcludeContent`), and `<gitdir>/harness-meta.json` (`handle`'s metadata fields from `fromCheckpoint.meta`), reset `<gitdir>/index` to `fromCheckpoint.headSha`, and—before running `git status --porcelain=v2 -z --no-renames --untracked-files=all` to compute `currentStatusMap`—restore any tracked/checkpointed `**/.gitignore` files from `fromCheckpoint.treeSha` and unlink any newly created untracked `**/.gitignore` files absent from `fromCheckpoint.treeSha` so `currentStatusMap` is evaluated under `fromCheckpoint`'s exact `.gitignore` rules, (2) unlink every path in `symDiff(fromCheckpoint.statusMap, currentStatusMap)` absent from both `fromCheckpoint.treeSha` and `oversizedUntrackedBlobs` (and if any path in `symDiff` is present as a file/symlink in `fromCheckpoint.treeSha` or `oversizedUntrackedBlobs` but is currently a directory on disk via `lstat`, `rm -rf` that directory first), pruning empty parent directories, (3) populate `<tmpIndex>` via `GIT_INDEX_FILE=<tmpIndex> git read-tree <fromCheckpoint.treeSha>` and materialize the `symDiff` paths present in `fromCheckpoint.treeSha` via `GIT_INDEX_FILE=<tmpIndex> git checkout-index -f -z --stdin` (falling back to `-a` only if worktree-local `.git` integrity failed), then restore the live `<gitdir>/index` to `fromCheckpoint.indexTreeSha` (`git read-tree <fromCheckpoint.indexTreeSha>` + `git update-index --refresh -q`), and (4) ensure parent directories exist (`fs.mkdir(dirname, { recursive: true })`) and copy back `fromCheckpoint.oversizedUntrackedBlobs`.
3. **Automatic Parent Working-Tree Flush, `getConflictLease()`, Side-Effect-Free `inspect()`, Stateless `git merge-tree --write-tree` `commitChild`/`syncChild` & Regex `conflictCleanCheck`:** `git.cowWorktree` implements `BranchableScope.getConflictLease(handle)` by returning `fs.allowWriteGlobs(Object.keys(handle.unresolvedConflictPaths))` whenever `unresolvedConflictPaths` is non-empty, which `@paraharness/core` calls after `forkChild`, `commitChild`, `syncChild`, and `syncRoot` to attach temporary conflict write leases without Core ever inspecting git-specific handle fields directly. Whenever `conflictCleanCheck`, `Automatic Parent Working-Tree Flush`, or `commitChild` inspects a handle, any entry in `unresolvedConflictPaths` whose current working-tree `${mode}:${sha256}` differs from its recorded conflict-time digest (or has been unlinked) **and** contains no paired conflict markers is pruned from `unresolvedConflictPaths` in `<gitdir>/harness-meta.json` (and `git.snapshotAndReset()` clears `unresolvedConflictPaths = {}`). Before `forkChild`, `syncChild`, or `commitChild` reads or reconciles against `parentHandle`, `git.cowWorktree` first prunes resolved entries from `parentHandle.unresolvedConflictPaths` and automatically commits onto `parentHandle.HEAD` any non-excluded dirty working-tree files on `parentHandle` that are **not** in `parentHandle.unresolvedConflictPaths` and contain no conflict markers (e.g., `coordinator` edits to `packages/*/src/index.ts` or `TECH_DESIGN.md`) while keeping `parentHandle.baseRef` pinned (`forkChild` serializes this flush under an internal per-`parentHandle` async mutex without re-entering `ScopeLockManager.acquireWrite`, whereas `commitChild` and `syncChild` run under the caller's exclusive write lock; if `parentHandle.unresolvedConflictPaths` remains non-empty, `forkChild` copies `parentHandle.unresolvedConflictPaths` into `childHandle.unresolvedConflictPaths`, and `@paraharness/core` arms `conflictCheckArmed = true` and attaches `scope.getConflictLease(childHandle)`—i.e., `fs.allowWriteGlobs(Object.keys(childHandle.unresolvedConflictPaths))`—to the child's `agent-frame.activeLeases` and any enclosing `loop-frame.grantedLoopLeases`). Whenever `inspect()` is called (prior to `evaluator`, `.crossVerifyWith()`, `.arbiter()`, or `commitChild()`), it reuses `HEAD` directly when the working tree is clean (`statusMap.size === 0` and `HEAD !== baseRef`) or uses a temporary `GIT_INDEX_FILE` (`git write-tree` + `git commit-tree -p <handle.baseRef>`) to write a commit object into the host object store (pinning `refs/harness/candidates/<run-id>/<branch-index>` for speculative branches) and compute `diffStat`/`mutatedFiles` against `handle.baseRef` without mutating the worktree's live `HEAD` or `.git/index`. At `commitChild` time, if `child.unresolvedConflictPaths` remains non-empty after pruning or `conflictCleanCheck` finds paired conflict markers on `child`, `commitChild` immediately returns `status: 'conflict'`; otherwise, if `parent.HEAD` ($C_1$) has advanced past `child.baseRef` ($C_0$), `git.cowWorktree` synthesizes **both** $C_1' = \text{git commit-tree } C_1^{\text{tree}} -p\ C_0$ and $C_{\text{child}} = \text{git commit-tree } T_{\text{child}} -p\ C_0$ and performs a stateless 3-way commit merge (`git merge-tree --write-tree $C_1' $C_{\text{child}}`, where Git 2.38+ is guaranteed to resolve $C_0$ as the exact 3-way merge-base via shared immediate parent ancestry without `--merge-base`, even when `syncRoot` or squash-merged `git rebase --onto` rewrote $C_1$'s real commit ancestry): if clean, `child.baseRef` stays pinned to $C_0$, any path in `parentHandle.unresolvedConflictPaths` modified/added/deleted by $C_{\text{target}}$ is reset in `parentHandle`'s working tree to match $C_1$, `pendingParentHeadSha: $C_{\text{target}}` is persisted in `<parentGitDir>/harness-meta.json` before `git read-tree -u -m $C_1 $C_{\text{target}}`, and `pendingParentHeadSha` (along with resolved conflict paths) is cleared once `git update-ref HEAD $C_{\text{target}} $C_1` completes; if conflicted, `parent` remains untouched while `commitChild` first persists `inFlightMerge: { targetHeadSha: C_1, mergedTreeSha: T_merged, priorTreeSha: T_child, unresolvedConflictPaths }` in `<childGitDir>/harness-meta.json`, materializes the full merged tree $T_{\text{merged}}$ into `child` via `GIT_INDEX_FILE=<tmpIndex> git read-tree $T_{\text{merged}}` + `git checkout-index -f -a` (while unlinking paths in $C_0 \cup T_{\text{child}}$ absent from $T_{\text{merged}}$, with zero `.git/rebase-merge` state), and only after materialization and unlinking complete resets `child.HEAD` and `child`'s `.git/index` cleanly to $C_1$ (`child.baseRef = C_1`), records all conflicted file paths mapped to their conflict-materialized `${mode}:${sha256}` digests (including text-marker content conflicts, Modify/Delete, Add/Add, and Binary conflicts) in `child.unresolvedConflictPaths` (clearing `inFlightMerge`), and `@paraharness/core` attaches `scope.getConflictLease(child)` (`fs.allowWriteGlobs(Object.keys(child.unresolvedConflictPaths))`) to the child's `agent-frame.activeLeases` and any enclosing `loop-frame.grantedLoopLeases`. When `syncChild` rebases a suspended child onto an updated parent `HEAD` during `resumeFork` (after the runtime first calls `await scope.restoreCheckpoint(childHandle, childScopeCheckpoint)` whenever `syncedToParentCheckpoint` is not yet set and `childScopeCheckpoint` is present, ensuring 100% crash-replay idempotency), it uses the same atomic `inFlightMerge` + stateless `git merge-tree --write-tree $C_1' $C_{\text{child}}` materialization protocol (persisting `inFlightMerge`, materializing $T_{\text{merged}}$ via `git checkout-index -f -a` while unlinking paths in $C_0 \cup T_{\text{child}}$ absent from $T_{\text{merged}}$, then updating `pausedChild.HEAD`, `.git/index`, and `pausedChild.baseRef = C_1`, recording any conflicted paths mapped to their `${mode}:${sha256}` digests in `pausedChild.unresolvedConflictPaths`, clearing `inFlightMerge`, and attaching `scope.getConflictLease(pausedChild)` to the child's `agent-frame.activeLeases` and any enclosing `loop-frame.grantedLoopLeases`) and arms `conflictCleanCheck` (which prunes resolved entries in `unresolvedConflictPaths` and fails if `unresolvedConflictPaths` remains non-empty or if dirty/untracked files or `git diff <baseRef> HEAD` contain paired `<<<<<<<` / `=======` / `>>>>>>>` conflict blocks). Before any ephemeral child or root worktree is removed by `release()`, its terminal commit is pinned in the host repository (`refs/harness/completed/roots/<run-id>` for root worktrees and `refs/harness/completed/forks/<run-id>/<fork-id>` for child worktrees).
4. **In-Run Delegation vs. Linear-Chained Priority-Boosted Stacked-PR Queue Mutation (`syncRoot`):**
    * Sub-components belonging to the *same* deliverable/PR are delegated in-run via `.fork('delegate-partition', ...)`, sharing the Coordinator's Task Root Worktree and opening a single PR at the end of the flow.
    * Independent prerequisite tickets that warrant their own separate PR are enqueued into `engineeringLane` via `.mutatePlan().canSpawnTasks(...)` with `onPrerequisiteSpawned: 'suspend-and-yield-slot'`, `priorityStrategy: 'inherit-parent-with-boost'`, and `resumeWhen: 'prerequisite-exit'` (automatically chaining spawned tasks linearly $T_{\text{prevTip}} \leftarrow T_1 \leftarrow T_2 \leftarrow \dots \leftarrow T_k \leftarrow T_{\text{parent}}$ across single or multiple turns via `LedgerStore.mutateLanePlan` so stacked PRs form a single linear chain). The spawned prerequisite inherits the parent's aged priority plus a head-of-line boost so it schedules ahead of newly polled GitHub issues while the Coordinator resets `agent-frame.syncedToPrerequisiteCheckpoint = undefined`, quiesces active services, snapshots `headScopeCheckpoint = await scope.serializeCheckpoint(rootHandle)` in `recordStepTransition({ stepExecId, status: 'SUSPENDED', headScopeCheckpoint, telemetryJson })` to SQLite, and yields its concurrency slot. Both on initial `QUEUED -> RUNNING` start (for tasks with `dependsOn.length > 0`) and after re-acquiring a concurrency slot on `'SUSPENDED'` wakeup (first calling `await scope.restoreCheckpoint(rootHandle, headScopeCheckpoint)` whenever `syncedToPrerequisiteCheckpoint` is not yet set and `headScopeCheckpoint` was recorded—a 0-file no-op on the normal path when `symDiff` is empty, while rolling back any partial `HEAD` flush or working-tree materialization if a process crash occurred mid-`syncRoot` before `baseRef` or `syncedToPrerequisiteCheckpoint` was updated), `scope.syncRoot(rootHandle, prereqReceipts)` auto-flushes any non-conflicted dirty working-tree files on `rootHandle`, merges the prerequisite's `SEALED_UNMERGED` topology overlay (`syncRunOverlays`), synthesizes **both** $C_{\text{prereq}}' = \text{git commit-tree } C_{\text{prereq}}^{\text{tree}} -p\ C_0$ and $C_{\text{root}} = \text{git commit-tree } T_{\text{root}} -p\ C_0$ over $C_0 = \text{rootHandle.baseRef}$ to statelessly 3-way merge (`git merge-tree --write-tree $C_{\text{prereq}}' $C_{\text{root}}`, persisting `inFlightMerge` and materializing $T_{\text{merged}}$ via `GIT_INDEX_FILE=<tmpIndex> git read-tree $T_{\text{merged}}` + `git checkout-index -f -a` while unlinking paths in $C_0 \cup T_{\text{root}}$ absent from $T_{\text{merged}}$ before updating `rootHandle.HEAD`, `.git/index`, `rootHandle.baseRef`, and `rootHandle.unresolvedConflictPaths` and clearing `inFlightMerge`) the Task Root Worktree onto the tip prerequisite's host-pinned `headRef` ($C_{\text{prereq}}$), sets `scopeReceipt.baseBranch = 'fix/#102'` (if `fix/#102` is not yet merged into `origin/main`), appends `[PREREQUISITE_SYNC]` (with `updatedTopologyContracts` and `updatedGroundingDiffs`, or `[PREREQUISITE_FAILED]` with `isError: true`) directly to `spawnTasksCallId` in `pauseState.pendingToolBatch.completedResults`, and persists `syncedToPrerequisiteCheckpoint` (plus updated `baseScopeCheckpoint` via `updateContinuationStack(..., { baseScopeCheckpoint })` and `recordStepTransition({ stepExecId, status: 'RUNNING', baseScopeCheckpoint, telemetryJson })`) in `LedgerStore` before re-acquiring quiesced services and draining `remainingCalls` (clearing `agent-frame.syncedToPrerequisiteCheckpoint = undefined` once `remainingCalls` drains and the `role: 'tool'` frame is emitted so subsequent `spawnTasks` or `addDependencies` calls in later turns execute a full prerequisite sync). When the parent ticket finishes, `publishPr` opens a clean stacked PR targeting `--base ${scopeReceipt.baseBranch}`.
5. **Isolated PR-Branch Reconciliation (`rebase-onto-base` with `git rebase --onto`, Rollback Safety & In-Place Handle Update):** Because `engineeringFlow` pushes individual feature branches (`fix/<ref>`) and opens pull requests for review, `workspace` is configured with `.reconcileStrategy('rebase-onto-base', { verifyWith: verifySuite })` (executed by `git.commitAndPush` right before pushing) so each completed Task Root Worktree first auto-flushes/commits any uncommitted working-tree changes onto `rootHandle.HEAD` (so `preStepHeadSha = git rev-parse HEAD` is a commit object capturing 100% of the step's edits), persists `inFlightCommitAndPush: { preStepHeadSha, preStepBaseRef }` in `<gitdir>/harness-meta.json`, runs `git fetch origin`, and wraps the squash + rebase + verification + push sequence in a `try/catch` (mirrored by `reattachRoot` on boot if `inFlightCommitAndPush` is present) that executes `git rebase --abort` (if in progress), runs `git reset --hard <preStepHeadSha>`, and restores `rootHandle.baseRef = preStepBaseRef` on failure so retries never wipe out uncommitted worker edits or leak upstream commits. Inside the `try` block, it squashes its changes since `baseRef`, checks if `scopeReceipt.baseBranch` has already merged into `origin/main` (falling back to `'main'` if merged and deleted, or failing if closed unmerged), rebases cleanly via `git rebase --onto origin/${resolvedBaseBranch} <rootHandle.baseRef> HEAD` (handling squash-merged prerequisites cleanly), pushes with `git push --force-with-lease`, and updates `rootHandle` (`baseRef = rev-parse(origin/${resolvedBaseBranch})`, `baseBranch = resolvedBaseBranch`, `branchName`, `headRef = rev-parse(HEAD)`) and `<gitdir>/harness-meta.json` (clearing `inFlightCommitAndPush`) in-place so `publishPr` inspects the exact pushed state. (For post-review auto-merge landing lanes that merge approved PRs directly into `origin/main`, `git.cowWorktree` supports `.reconcileStrategy('batch-merge-train', ...)` to verify cumulative batches in a single test window.)

---

# 4. Actor Ontology & Permission Matrix

All five actors are instances of `P.agent` configured with distinct `P.policy` masks, `.partitions()` extractors, tool bundles, services, and capabilities. `coordinator`, `worker`/`guardedWorker`, and `evaluator` bind `.prefixGroup(engineeringPrefix)` (`toolsMode: 'role-scoped'`) so they share a byte-identical wire `system` prompt while keeping role-scoped wire `tools` arrays:

| Actor ID | Prefix Group | Model / Pool | Write Policy & Capability Lease Mask | Mounted Tools & Skills | Primary Responsibility |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`worker` / `guardedWorker`** | `engineeringPrefix` (`role-scoped`) | `workerModels` (`sonnet` -> `opus` escalation) | **`workerBasePolicy`** (or **`fastPathPolicy`**): Can write implementation files and create *new* test files (`onlyExistingAtBaseRef: true`); Clause 1 denies edits to `packages/*/src/index.ts`, `TECH_DESIGN.md`, `PRODUCT_SPEC.md`, `openapi.yaml`, `**/.gitignore`, and `.harness/**` in-band (`'deny-with-error'`, instructing the worker to raise `contractViolation`); Clause 2 intercepts edits to existing `**/*.test.ts` / `**/*.test.tsx` files (`'raise-interrupt'`, `leaseRequest`). Binds `.onAbort(git.snapshotAndReset())` and actor-level `.onInterrupt(leaseRequest)` adjudication with path-subset-verified loop-scoped lease inheritance & declaration-ordered tool replay (`PendingToolBatch.remainingCalls`). | `fs.codingTools`, `verifySuite.asTool()` (post-flight diffed via `diffEffects`), `dbMigrationSkill`, `uiVerificationSkill`, `sharedProceduralSkills` (plus `git.candidateComparisonTools` during speculative cross-pollination). | Implements code changes inside a partition; runs `verifySuite.asTool()` mid-session and must pass `verifySuite`, `conflictCleanCheck`, and scoped `P.check` gates in `beforeStop`. |
| **`evaluator`** | `engineeringPrefix` (`role-scoped`) | `opus` | **`readOnlyPolicy`**: Denied write on `**/*`. | `fs.readOnlyTools`, `uiVerificationSkill` (mounts `browserSandbox` daemon for headless Chromium verification after `.act()` daemons quiesce). | Adversarial code auditor, runtime UI verifier, and active lesson violation reporter (`violatedLessonIds`, receiving the worker's recalled lessons via `verifiedWorkerLoop.distillLessonsInto(repoLessons)`). |
| **`leaseAdjudicator`** | Standalone | `opus` | **`readOnlyPolicy`**: Denied write on `**/*` (zero conflict of interest with implementation code). | `fs.readOnlyTools`. | Adjudicates `leaseRequest` interrupts from `guardedWorker` for existing test files; grants `fs.allowWriteGlobs` lease (validated against `req.requestedPaths`, persisted on `loop-frame.grantedLoopLeases`, and triggering immediate declaration-ordered replay of `remainingCalls`) or raises `normativeEscalation` to `owner`. |
| **`candidateArbiter`** | Standalone | `opus` | **`readOnlyPolicy`**: Denied write on `**/*`. | `fs.readOnlyTools`, `git.candidateComparisonTools` (`evalInCandidates`, `diffCandidates`, `readCandidateFile`). | Judges $\ge 2$ surviving speculative worktrees, $\ge 2$ parked branches, or contested `COMPLETED` vs `PARKED_ON_ESCALATION` branches using AST cross-test reports and live benchmarks; returns `select-winner`, non-destructive `unpark-escalation`, or `reject-all`. |
| **`coordinator`** | `engineeringPrefix` (`role-scoped`) | `opus` | **`coordinatorPolicy`**: Allowed to write `TECH_DESIGN.md` and partition boundary files (`packages/*/src/index.ts`); denied write (`.onViolation('deny-with-error')`) on leaf implementation files and exogenous specs (`PRODUCT_SPEC.md`, `openapi.yaml`) unless granted a `LeaseDelta` by `owner` via `.escalate(normativeEscalation)`. | `fs.codingTools`, `git.refReaderTools` (`readRefFile`, `diffRefs`, `listRefFiles`), `.fork()`, `.speculate()`, `.mutatePlan()`, `.escalate()`, and native `resumeFork` (from `.onChildInterrupt()`). | Owns long-horizon architectural coherence, partition contracts, downward forks, speculative tournaments, fast-path aborted ref inspection, and single-timeline `contractViolation` resolution via `suspendAndReturnToParent` + `resumeFork` (recalling `repoLessons` with `recordOutcomes: false`). |

---

# 5. Interrupt & Truth-Maintenance Protocols

## 5.1 Protocol 1: The Test Ratchet with Chained Policy Clauses, Post-Flight Verified Test Runs, Loop-Scoped Leases & Declaration-Ordered Tool Replay (`leaseRequest -> leaseAdjudicator`)

1. `guardedWorker` modifies an internal function signature or fixes a bug and invokes `verifySuite.asTool()` mid-session to run tests before attempting completion. (Because `verifySuite.asTool()` compiles to a `LocalStreamCheckToolNode` with `effectTracking: 'subprocess-post-flight'` and omits static `ToolDriver.describeEffects`, `git.cowWorktree.diffEffects()` verifies post-flight that worktree-local `.git` metadata is intact and that the test execution did not write to any protected boundary, spec, `.gitignore`, `.harness/**`, or existing test file.)
2. Observing a failure in `packages/api/test/auth.test.ts`, `guardedWorker` invokes `edit_file` on `packages/api/test/auth.test.ts` (which existed at `baseRef`, matching `onlyExistingAtBaseRef: true`). `workerBasePolicy` Clause 2 intercepts the pre-flight `FsToolEffect (mutatesScope: true, mode: 'write')` in declaration order across the assistant turn, records the turn batch in `pauseState.pendingToolBatch` (`remainingCalls`), and raises `leaseRequest({ requestedPaths: ['packages/api/test/auth.test.ts'], justification: '...' })` via its synchronous violation mapper.
3. The actor-level `.onInterrupt(leaseRequest)` handler bound to `guardedWorker` receives `(actorInput, req)` and invokes `leaseAdjudicator` (read-only):
    * **Case A (Mechanical Entailment):** The test failed only because an internal mock or parameter list changed in accordance with the ticket. `leaseAdjudicator` returns `approved: true, unlockedGlobs: ['packages/api/test/auth.test.ts']`. `.elevateLeaseWhen()` verifies that `unlockedGlobs` are `.test.ts`/`.test.tsx` paths within `req.requestedPaths`, grants `fs.allowWriteGlobs(verdict.unlockedGlobs)` on both the active `agent-frame` and the enclosing `verifiedWorkerLoop`'s `loop-frame.grantedLoopLeases` (so the lease survives subsequent loop iterations and model escalations), and Core **iterates `pauseState.pendingToolBatch.remainingCalls` in strict `(1..k)` declaration order, immediately executing the suspended `edit_file` call and any subsequent calls** before resuming `guardedWorker` with `[Lease Elevated: ...]\n\n<edit_file result>`.
    * **Case B (Buggy Implementation):** The existing test caught a real regression introduced by `guardedWorker`. `leaseAdjudicator` returns `approved: false` with diagnostic feedback; Core records `[Lease Denied: ...]` (`isError: true`) for the blocked test edits, skips any subsequent dependent calls in `pauseState.pendingToolBatch.remainingCalls` with `[Skipped: Preceding tool call in turn batch was denied]` (`isError: true`), and `guardedWorker` fixes its implementation code.
    * **Case C (Normative Contradiction & Speculative Parking):** The existing test asserts legacy product behavior $Y$ that contradicts `PRODUCT_SPEC.md` $X$. `leaseAdjudicator` raises `normativeEscalation` to human `owner`: if `owner` approves spec mutation, the nested `$esc.elevateLeaseWhen()` attaches the `LeaseDelta` for `PRODUCT_SPEC.md` / `openapi.yaml` directly to the outer `guardedWorker`'s `agent-frame.activeLeases` and enclosing `loop-frame.grantedLoopLeases`, while `$esc.resumeWith()` resumes `leaseAdjudicator` on `pauseState.pendingAdjudication.adjudicatorStack` to return its final verdict before draining `guardedWorker`'s `pauseState.pendingToolBatch.remainingCalls`. If `guardedWorker` is currently executing inside a `.speculate()` tournament branch, the tournament supervisor **parks** the branch (`status: 'PARKED_ON_ESCALATION'`) at the `.ask(owner)` boundary until all sibling speculative branches finish.

## 5.2 Protocol 2: Single-Timeline Endogenous Contract Violation (`contractViolation -> coordinator` via `suspendAndReturnToParent` & `resumeFork`)

1. `coordinator` dispatches one or more downward forks via `delegate-partition` (e.g., an `api` fork and a concurrent `db` fork), each executing `verifiedWorkerLoop` (`loop-frame` -> `agent-frame`).
2. The forked `guardedWorker` in `api` discovers that `packages/db/src/index.ts` lacks a transaction handle required to implement the ticket cleanly.
3. Denied in-band by `workerBasePolicy` Clause 1 (`fs.boundaryGuard(repoPartitions)`) from editing `packages/db/src/index.ts`, the `api` worker raises `contractViolation({ partition: 'db', brokenInvariant: '...', proof: '...', proposedPatch: '...' })`.
4. `coordinator.onChildInterrupt(contractViolation)` executes `.pauseSiblingForksInPartitions((v) => repoTopology.affectedBy(v.partition)).suspendAndReturnToParent()`:
    * Stops any active `ServiceSession` daemons, snapshots `childScopeCheckpoint = await scope.serializeCheckpoint(childHandle)`, and serializes the raising `api` fork's full `ContinuationFrame[]` stack (`[loop-frame(verified-worker-loop), agent-frame(guardedWorker)]`) and `childScopeCheckpoint` at its interrupt tool call (`suspendedForkId: 'fork_api_01#1'`, persisted on both `SuspendedForkRecord.childScopeCheckpoint` and `fork-batch-frame.forks[i].childScopeCheckpoint`).
    * Because `repoTopology.affectedBy('db')` returns `['db', 'api', 'web']`, any concurrent sibling fork running in `'db'` itself (as well as `'api'` or `'web'`) is paused cleanly at the parent turn-batch barrier—either at its current tool/user boundary (`pausedAtPhase: 'TOOL_BOUNDARY'`, canceling any pending sibling human request) or, if its turn ended with a final completion output or was inside `beforeStop`/`evaluator`, by aborting the gate/evaluator and rolling the `loop-frame` back to `'act'` at `preservedActLeafMessageId` (`pausedAtPhase: 'BEFORE_STOP_GATE'`)—stopping its active `ServiceSession` daemons and snapshotting `childScopeCheckpoint = await scope.serializeCheckpoint(childHandle)` on `SuspendedForkRecord.childScopeCheckpoint` and `fork-batch-frame.forks[i].childScopeCheckpoint` before calling `LedgerStore.recordForkSuspension(...)`.
    * Resolves the open `delegate-partition` tool call(s) in `coordinator` as normal wire `tool_result` frames (`status: 'SUSPENDED_ON_INTERRUPT'` for `fork_api_01#1` and `status: 'PAUSED_BY_SIBLING_INTERRUPT'` for `fork_db_01#1`).
5. Continuing on its **single uninterrupted timeline**, `coordinator` updates the `db` contract in `repoTopology`'s per-run CoW overlay (incrementing `db` from Epoch $E$ to $E+1$ without invalidating `engineeringPrefix`'s wire `system` prompt or polluting concurrent runs), edits `packages/db/src/index.ts` (which `git.cowWorktree` automatically flushes to `parent.HEAD` before fork/sync/commit), delegates or resumes `fork_db_01#1` to implement the underlying `db` support and commit it into the Task Root Worktree, and then invokes `resumeFork({ suspendedForkIds: ['fork_api_01#1'], action: 'resume', resolutionSummary: '...' })`.
6. `resumeFork` invokes `git.cowWorktree.syncChild()` to statelessly 3-way merge (`git merge-tree --write-tree`) uncommitted edits in `fork_api_01#1` onto the updated Task Root Worktree `HEAD` (recording `syncedToParentCheckpoint` and `syncResultJson`), places `{ resolution, updatedTopologyContracts, updatedGroundingDiffs, sync, conflict }` into `pauseState.pendingToolBatch.completedResults` as the `tool_result` of `fork_api_01#1`'s suspended `contractViolation` call (immediately setting `resumeFrameInjected = true`), re-acquires any quiesced services **before** draining `remainingCalls` (appending `[SERVICE_REACQUIRED]` to the emitted `role: 'tool'` frame if restarted), runs `guardedWorker` through `beforeStop`, pops up `continuationStack` to run `verifiedWorkerLoop`'s `evaluator`, commits the verified result via `commitChild`, and returns the completed receipt to `coordinator`.

## 5.3 Protocol 3: Exogenous Specification Update & Non-Destructive Contested Speculative Arbitration (`normativeEscalation -> candidateArbiter -> owner`)

1. Inside `.speculate('explore-candidates', ...)`, Branch 0 hits a spec/test contradiction and parks on `normativeEscalation` (`status: 'PARKED_ON_ESCALATION'`), while Branch 1 completes without escalating (`status: 'COMPLETED'`).
2. Because $\ge 1$ branch is parked on an escalation, `.speculate()` **refuses to short-circuit arbitration** and invokes `candidateArbiter` with both Branch 0's parked escalation payload and Branch 1's completed receipt and cross-test report.
3. If `candidateArbiter` determines Branch 1 solved the problem cleanly without violating the spec, it returns `{ decision: 'select-winner', winnerBranchIndex: 1, ... }`, discarding Branch 0 without paging `owner`.
4. If `candidateArbiter` determines Branch 0 flagged a real normative contradiction that Branch 1 hacked around, it returns `{ decision: 'unpark-escalation', parkedBranchIndex: 0, rationale: '...' }`. The runtime **retains Branch 1's completed worktree handle alive**, pages `owner` on Slack for Branch 0, resumes Branch 0 with the human's ruling until it finishes `verifiedWorkerLoop`, and re-runs `candidateArbiter` (with `humanRulingsHistory` and `failedBranches`) to either select the final winning worktree (`'select-winner'`) or reject all candidates (`'reject-all'`) if neither candidate satisfies the owner's ruling.

---

# 6. Complete Production Implementation (`engineering-harness.ts`)

~~~ts
import { P, z } from '@paraharness/core';
import { claude } from '@paraharness/claude';
import { fs } from '@paraharness/fs';
import { git } from '@paraharness/git';
import { github } from '@paraharness/github';
import { md } from '@paraharness/markdown';
import { local, mcp } from '@paraharness/node';
import { slack } from '@paraharness/slack';
import { sqlite } from '@paraharness/sqlite';

// ============================================================================
// 1. Application Schemas, Signals & Interrupts
// ============================================================================

const partitionEnum = z.enum(['db', 'api', 'web']);

export const workItem = z.object({
  ref: z.string(),
  title: z.string(),
  description: z.string(),
  routingTier: z.enum(['auto', 'leaf-only', 'deep']).default('auto'),
  targetPartitions: z.array(partitionEnum).default([]),
  dependsOn: z.array(z.string()).default([]),
});

export const workReceipt = z.object({
  summary: z.string(),
  discoveredInvariants: z.array(z.string()).default([]),
  residualRisks: z.array(z.string()).default([]),
});

export const evaluationResult = z.object({
  accepted: z.boolean(),
  deficits: z.array(z.string()).default([]),
});

const forkRequestSchema = z.object({
  partition: partitionEnum,
  objective: z.string(),
  estimatedTurns: z.number().int().min(1).max(30).default(8),
  contextNotes: z.string().default(''),
});

const speculateRequestSchema = z.object({
  partition: partitionEnum,
  problemStatement: z.string(),
  strategyA: z.string(),
  strategyB: z.string(),
});

const arbiterVerdictSchema = z.discriminatedUnion('decision', [
  z.object({
    decision: z.literal('select-winner'),
    winnerBranchIndex: z.union([z.literal(0), z.literal(1)]),
    rationale: z.string(),
    followUpDeficits: z.array(z.string()).default([]),
  }),
  z.object({
    decision: z.literal('unpark-escalation'),
    parkedBranchIndex: z.union([z.literal(0), z.literal(1)]),
    rationale: z.string(),
  }),
  z.object({
    decision: z.literal('reject-all'),
    rationale: z.string(),
  }),
]);

const ownerDecisionSchema = z.object({
  selectedOptionId: z.string(),
  approveSpecMutation: z.boolean().default(false),
  unlockedSpecFiles: z.array(z.enum(['PRODUCT_SPEC.md', 'openapi.yaml'])).default([]),
  note: z.string().optional(),
});

// Signals
export const steerSignal = P.signal('steer').payload(
  z.object({ note: z.string() }),
);

export const changeShippedSignal = P.signal('change-shipped').payload(
  z.object({ ref: z.string(), mergeCommitSha: z.string(), baseBranch: z.string() }),
);

export const prClosedUnmergedSignal = P.signal('pr-closed-unmerged').payload(
  z.object({ ref: z.string() }),
);

export const highLeverageLessonSignal = P.signal('high-leverage-lesson').payload(
  z.object({
    lessonId: z.string(),
    directive: z.string(),
    partition: partitionEnum.optional(),
    cleanPassCount: z.number(),
    violatedCount: z.number(),
  }),
);

// Interrupts
export const scopeTripwire = P.interrupt('scope-exceeded').payload(
  z.object({
    reason: z.string(),
    implicatedPartitions: z.array(partitionEnum),
    findings: z.string(),
  }),
);

export const leaseRequest = P.interrupt('lease-request').payload(
  z.object({
    requestedPaths: z.array(z.string()),
    justification: z.string(),
  }),
);

export const contractViolation = P.interrupt('contract-violation').payload(
  z.object({
    partition: partitionEnum,
    brokenInvariant: z.string(),
    proof: z.string(),
    proposedPatch: z.string(),
  }),
);

export const normativeEscalation = P.interrupt('normative-tradeoff').payload(
  z.object({
    question: z.string(),
    options: z.array(
      z.object({
        id: z.string(),
        summary: z.string(),
        tradeoffs: z.string(),
        proposedSpecDiff: z.string().optional(),
        candidateCommitRef: z.string().optional(),
      }),
    ),
    recommendation: z.string(),
  }),
);

// ============================================================================
// 2. Capacity Pools, Models & Correlated Two-Temperature Ledger
// ============================================================================

const runner = local.runner({ slots: 8, maxDaemons: 8 });

const claudeAccounts = P.pool('claude-accounts')
  .with(
    claude.cliAccount('sub-a').configDir('~/.claude-a'),
    claude.cliAccount('sub-b').configDir('~/.claude-b'),
  )
  .strategy('soonest-reset')
  .fallback(claude.cliAccount('api-fallback').apiKey(P.env('ANTHROPIC_API_KEY')));

const sonnet = claude
  .model('sonnet', { id: 'claude-sonnet-4-6' })
  .accountPool(claudeAccounts);

const opus = claude
  .model('opus', { id: 'claude-opus-4-6' })
  .accountPool(claudeAccounts);

const workerModels = P.pool('worker-models')
  .with(sonnet, opus)
  .strategy(($) => $.escalateOnRetry().minSuccessRate(0.75).minSamples(10));

const ledger = sqlite
  .ledger('.harness/state.sqlite')
  .compactWhen(($c) =>
    $c
      .onSignal(changeShippedSignal, {
        correlateBy: (sig) => sig.ref,
        afterGracePeriodHours: 24,
      })
      .onTerminalExit(['done'], { afterGracePeriodHours: 168 })
      .retainFailedRunsForDays(14),
  );

const slackBot = slack.bot({
  appToken: P.env('SLACK_APP_TOKEN'),
  botToken: P.env('SLACK_BOT_TOKEN'),
  channel: P.env('SLACK_CHANNEL_ID'),
});

const owner = P.human('owner')
  .keepAliveSeconds(60)
  .notify(slackBot);

// ============================================================================
// 3. OS Subprocess Commands, Stream Checks, Services (`@paraharness/node`) & Streams
// ============================================================================

const drizzleGenerate = local
  .command('drizzle-generate')
  .runner(runner)
  .stdin('closed')
  .env({ CI: 'true', GIT_TERMINAL_PROMPT: '0' })
  .argv(['pnpm', '--filter', '@acme/db', 'db:generate']);

// verifySuite.asTool() sets effectTracking: 'subprocess-post-flight' (omitting static ToolDriver.describeEffects)
// so CheckpointableScope.diffEffects() deterministically verifies post-flight that test runs never mutate protected files.
const verifySuite = local
  .streamCheck('verify-suite')
  .runner(runner)
  .argv(['pnpm', 'test', '--run'])
  .circuitBreakWhenStdout(/FAIL\s+packages\/.*?\n\s*●/, {
    graceLinesAfterMatch: 25,
  })
  .timeoutMinutes(5);

const localPostgres = local
  .daemon('local-pg')
  .runner(runner)
  .lifecycle('skill')
  .port('pgPort')
  .start(({ ports, scopeKey }) => [
    'docker', 'run', '--rm',
    '--name', `harness-pg-${scopeKey}`,
    '-p', `${ports.pgPort}:5432`,
    '--tmpfs', '/var/lib/postgresql/data',
    '-e', 'PGDATA=/var/lib/postgresql/data/pgdata',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:16-alpine',
  ])
  .stopCommand(({ scopeKey }) => ['docker', 'rm', '-f', '-v', `harness-pg-${scopeKey}`])
  .readyWhenStdout(
    /listening on IPv4 address "0\.0\.0\.0", port 5432[\s\S]*database system is ready to accept connections/,
  )
  .interact('psql', {
    command: ({ ports }) => ['psql', '-P', 'pager=off', `postgres://postgres@localhost:${ports.pgPort}/postgres`],
    frameDelimiter: /postgres[=>\-#\x27("$\*][#>]\s*$/,
    idleSettleMs: 300,
    timeoutSeconds: 10,
  });

const browserSandbox = local
  .daemon('browser-sandbox')
  .runner(runner)
  .lifecycle('skill')
  .port('webPort')
  .port('cdpPort')
  .start(({ ports }) => [
    'pnpm', '--filter', '@acme/web', 'dev:headless',
    '--port', String(ports.webPort),
    '--remote-debugging-port', String(ports.cdpPort),
  ])
  .readyWhenStdout(/Ready in \d+ms/)
  .interact('browser-ctl', {
    command: ({ ports }) => ['pnpm', 'tsx', '.harness/bin/cdp-repl.ts', String(ports.cdpPort)],
    frameDelimiter: /cdp>\s*$/,
    idleSettleMs: 250,
    timeoutSeconds: 15,
  });

const githubWebhookSource = github.webhookStream({
  repo: 'acme/app',
  secret: P.env('GH_WEBHOOK_SECRET'),
  events: ['pull_request.closed'],
});

const githubMergeStream = P.stream('github-merge-events')
  .source(githubWebhookSource)
  .filter((ev) => ev.pull_request.merged === true && /^fix\//.test(ev.pull_request.head.ref))
  .emitSignal(changeShippedSignal, (ev) => ({
    ref: ev.pull_request.head.ref.replace(/^fix\//, ''),
    mergeCommitSha: ev.pull_request.merge_commit_sha,
    baseBranch: ev.pull_request.base.ref,
  }));

const githubPrClosedStream = P.stream('github-pr-closed-events')
  .source(githubWebhookSource)
  .filter((ev) => ev.pull_request.merged === false && /^fix\//.test(ev.pull_request.head.ref))
  .emitSignal(prClosedUnmergedSignal, (ev) => ({
    ref: ev.pull_request.head.ref.replace(/^fix\//, ''),
  }));

// ============================================================================
// 4. Relational Topology (`@paraharness/core`), FS Partition Map & CoW Worktree Scope
// ============================================================================

const repoTopology = P.topology('app-topology')
  .store(sqlite.topologyStore('.harness/state.sqlite'))
  .partitions({
    db: {},
    api: { dependsOn: ['db'] },
    web: { dependsOn: ['api'] },
  })
  .commitOverlayWhen({
    onSignal: {
      signal: changeShippedSignal,
      correlateBy: (sig) => sig.ref,
      baseBranch: (sig) => sig.baseBranch,
    },
    discardOnSignal: {
      signal: prClosedUnmergedSignal,
      correlateBy: (sig) => sig.ref,
    },
    maxSealedAgeHours: 168,
  });

const repoPartitions = fs.partitionMap(repoTopology, {
  db: {
    globs: ['packages/db/**'],
    boundaryGlobs: ['packages/db/src/index.ts'],
  },
  api: {
    globs: ['packages/api/**'],
    boundaryGlobs: ['packages/api/src/index.ts'],
  },
  web: {
    globs: ['packages/web/**'],
    boundaryGlobs: ['packages/web/src/index.ts'],
  },
});

const workspace = git
  .cowWorktree({ repo: '.', dir: '.harness/workspaces' })
  .excludeFromCloneGlobs([
    'dist/**',
    '.next/**',
    'coverage/**',
    '**/*.tsbuildinfo',
    '.harness-ephemeral/**',
    '**/node_modules/.cache/**',
    '**/node_modules/.vite/**',
    '**/node_modules/.vitest/**',
  ])
  .setup(
    local
      .command('install')
      .runner(runner)
      .stdin('closed')
      .env({ CI: 'true' })
      .argv(['pnpm', 'install', '--frozen-lockfile']),
  )
  .lockfileGate('pnpm-lock.yaml')
  .checkpointPolicy({
    partitionMap: repoPartitions,
    excludeGlobs: [
      'dist/**',
      '.next/**',
      'coverage/**',
      '**/*.tsbuildinfo',
      '.harness-ephemeral/**',
      '**/node_modules/.cache/**',
      '**/node_modules/.vite/**',
      '**/node_modules/.vitest/**',
    ],
    maxUntrackedFileSizeBytes: 1_048_576,
  })
  .reconcileStrategy('rebase-onto-base', {
    verifyWith: verifySuite,
  });

// ============================================================================
// 5. Rules, Deduplicated Evidence-Based Lessons, Skills & Role-Scoped Prefix Group
// ============================================================================

const forbidDrizzleInApiCheck = fs.regexCheck('forbid-drizzle-in-api', {
  targetGlobs: ['packages/api/**/*.ts'],
  forbidPattern: /from\s+['"]drizzle-orm['"]/,
  violationMessage: 'Direct drizzle-orm imports are forbidden in packages/api; use @acme/db repositories.',
});

const forbidDropColumnCheck = fs.regexCheck('forbid-drop-column', {
  targetGlobs: ['packages/db/migrations/*.sql'],
  forbidPattern: /DROP\s+(COLUMN|TABLE)/i,
  violationMessage: 'Destructive SQL migrations require explicit owner escalation.',
});

export const repoRules = P.rules('repo-rules')
  .global(
    {
      id: 'no-non-null-assertions',
      directive: 'Never use TypeScript non-null assertion operators (!) in production code paths.',
    },
    md.globalRules('.harness/rules/global/*.md'),
    sqlite.globalRules('.harness/state.sqlite', { table: 'owner_global_rules' }),
  )
  .scoped(
    md.scopedRules('.harness/rules/scoped/**/*.md'),
    P.scopedRule('api-orm-boundary')
      .when({
        partitions: ['api'],
        effects: fs.matchGlobs(['packages/api/**/*.ts']),
      })
      .directive(fs.text('.harness/rules/api-orm-boundary.md'))
      .enforceBeforeStop(forbidDrizzleInApiCheck),
    P.scopedRule(md.scopedRule('.harness/rules/db-migrations.md'))
      .enforceBeforeStop(forbidDropColumnCheck),
  );

export const repoLessons = P.lessons('repo-lessons')
  .store(
    fs.jsonlLessonStore({
      definitionsDir: '.harness/lessons',
      statsPath: '.harness/lesson-stats.json',
      lockFile: '.harness/lessons.lock',
    }),
  )
  .queryFrom(workItem, (i) => `${i.title}\n${i.description}`)
  .distillWith(sonnet, ($d) =>
    $d
      .onLoopRecovery()
      .onGateRecovery({ minFailedChecks: 1 })
      .guidelines(fs.text('.harness/prompts/lesson-distiller.md')),
  )
  .scoring(($s) =>
    $s
      .slidingWindowInjections(20)
      .partitionMatchBoost(0.25)
      .decayOnPartitionEpochChange(0.85)
      .recall({ minScore: 0.2, maxItems: 5 }),
  )
  .retireAfter(($r) =>
    $r
      .maxViolations(3)
      .orMinCleanPassRate(0.35, { afterInjections: 12 }),
  )
  .emitSignalWhen(
    highLeverageLessonSignal,
    ($t) => $t.minCleanPasses(10).maxViolations(0).cooldownHours(72),
    (lesson) => ({
      lessonId: lesson.id,
      directive: lesson.directive,
      partition: lesson.partition as z.infer<typeof partitionEnum> | undefined,
      cleanPassCount: lesson.totalCleanPasses,
      violatedCount: lesson.totalViolated,
    }),
  );

export const dbMigrationSkill = P.skill(md.skill('.harness/skills/db-migrations/SKILL.md'))
  .unlocksTools(drizzleGenerate.asTool())
  .unlocksServices(localPostgres)
  .lease('until-completed-or-fork-exit');

export const uiVerificationSkill = P.skill('ui-verification')
  .when({
    partitions: ['web'],
    effects: fs.matchGlobs(['packages/web/src/**/*.tsx']),
  })
  .description('Pull when building or verifying interactive UI components, layouts, or client state.')
  .instructions(fs.text('.harness/skills/ui-verification/instructions.md'))
  .unlocksServices(browserSandbox)
  .lease('until-completed-or-fork-exit');

const sharedProceduralSkills = md.skills('.harness/skills/shared/*.md');

// Run-immutable wire prefix group shared across coordinator, worker/guardedWorker, and evaluator.
// Uses 'role-scoped' toolsMode so each role caches its own clean toolset without orchestration tool bloat,
// and excludes mutable repoTopology so in-run contract updates never invalidate byte 0 of the system prompt.
export const engineeringPrefix = P.prefixGroup('engineering-prefix')
  .toolsMode('role-scoped')
  .sharedGrounding(
    fs.text('PRODUCT_SPEC.md'),
    fs.text('TECH_DESIGN.md'),
  )
  .sharedInstructions(fs.text('.harness/prompts/base-posture.md'))
  .sharedRules(repoRules);

// ============================================================================
// 6. Capability Policies (Worker, Fast-Path, Read-Only & Coordinator Masks)
// ============================================================================

const readOnlyPolicy = P.policy('read-only')
  .guard(fs.writeGuard({ denyGlobs: ['**/*'] }))
  .onViolation('deny-with-error');

// Workers can write implementation code & new tests, but cannot mutate existing tests,
// partition boundary files (`packages/*/src/index.ts`), architecture docs, product specs, `.gitignore`, or `.harness/**`.
// Clause 1 denies boundary/spec/gitignore/.harness writes in-band (prompting the worker to raise contractViolation).
// Clause 2 intercepts existing test edits (`**/*.test.ts`) and raises leaseRequest to leaseAdjudicator.
// Binds git.snapshotAndReset() as the default abort hook so any step-replacing interrupt
// snapshots the dirty worktree to refs/harness/aborted/<run-id>/<stepExecId> and resets to clean baseRef.
const workerBasePolicy = P.policy('worker-base')
  .guard(
    fs.boundaryGuard(repoPartitions),
    fs.writeGuard({
      denyGlobs: [
        'TECH_DESIGN.md',
        'PRODUCT_SPEC.md',
        'openapi.yaml',
        '**/.gitignore',
        '.harness/**',
      ],
    }),
  )
  .onViolation(
    'deny-with-error',
    (violation) =>
      `${violation.violationSummary}. Raise 'contract-violation' if an upstream partition contract or boundary must change.`,
  )
  .guard(
    fs.writeGuard({
      denyGlobs: ['**/*.test.ts', '**/*.test.tsx'],
      onlyExistingAtBaseRef: true,
    }),
  )
  .onViolation('raise-interrupt', leaseRequest, (violation) => ({
    requestedPaths: fs.violatedPaths(violation),
    justification: violation.violationSummary,
  }))
  .onAbort(git.snapshotAndReset());

// Fast-path tripwires: tight bounds on optimistic single-agent attempts
const fastPathPolicy = workerBasePolicy
  .extend('fast-path-limits')
  .tripwire(fs.maxFilesMutated(4))
  .maxTurns(8)
  .maxCostUsd(1.0)
  .onLimitExceeded(($limit) =>
    $limit
      .flushWithInterrupt(scopeTripwire)
      .onAbort(git.snapshotAndReset()),
  );

// Coordinator owns endogenous architecture (`TECH_DESIGN.md` & `packages/*/src/index.ts`),
// delegates leaf implementation code to forked workers, and requires owner lease elevation
// via its voluntary .escalate(normativeEscalation) capability tool to mutate exogenous specs (`PRODUCT_SPEC.md`, `openapi.yaml`).
const coordinatorPolicy = P.policy('coordinator-policy')
  .guard(
    fs.writeGuard({
      denyGlobs: ['**/*'],
      allowGlobs: ['TECH_DESIGN.md', 'packages/*/src/index.ts'],
    }),
  )
  .onViolation(
    'deny-with-error',
    (violation) =>
      `${violation.violationSummary}. Delegate leaf implementation edits via 'delegate-partition' or invoke the 'normative-tradeoff' escalation tool to request an owner spec lease.`,
  );

// ============================================================================
// 7. Universal P.agent Actors & Iterative Refinement Loop (P.loop)
// ============================================================================

const crossTester = git.publicSurfaceCrossTester({
  runner,
  partitionMap: repoPartitions,
});

export const worker = P.agent('worker')
  .prefixGroup(engineeringPrefix)
  .model(workerModels)
  .topology(repoTopology)
  .rules(repoRules)
  .lessons(repoLessons)
  .skills(dbMigrationSkill, uiVerificationSkill, sharedProceduralSkills)
  .tools(fs.codingTools(runner), verifySuite.asTool())
  .instructions(fs.text('.harness/prompts/worker.md'))
  .timeoutMinutes(15)
  .beforeStop(verifySuite)
  .input(workItem)
  .partitions((item) => item.targetPartitions)
  .output(workReceipt)
  .canRaise(contractViolation);

export const evaluator = P.agent('evaluator')
  .prefixGroup(engineeringPrefix)
  .model(opus)
  .topology(repoTopology)
  .rules(repoRules)
  .skills(uiVerificationSkill)
  .policy(readOnlyPolicy)
  .tools(fs.readOnlyTools(runner))
  .instructions(fs.text('.harness/prompts/evaluator.md'))
  .timeoutMinutes(10)
  .input(
    z.object({
      item: workItem,
      candidate: workReceipt,
      scopeReceipt: git.ScopeReceiptSchema,
    }),
  )
  .partitions(({ item }) => item.targetPartitions)
  .output(evaluationResult)
  .canRaise(contractViolation);

export const leaseAdjudicator = P.agent('lease-adjudicator')
  .model(opus)
  .topology(repoTopology)
  .rules(repoRules)
  .policy(readOnlyPolicy)
  .tools(fs.readOnlyTools(runner))
  .instructions(fs.text('.harness/prompts/lease-adjudicator.md'))
  .input(z.object({ item: workItem, request: leaseRequest.schema }))
  .partitions(({ item }) => item.targetPartitions)
  .output(
    z.object({
      approved: z.boolean(),
      unlockedGlobs: z.array(z.string()),
      ruling: z.string(),
    }),
  )
  .canRaise(normativeEscalation);

export const candidateArbiter = P.agent('candidate-arbiter')
  .model(opus)
  .topology(repoTopology)
  .rules(repoRules)
  .policy(readOnlyPolicy)
  .tools(fs.readOnlyTools(runner), git.candidateComparisonTools(runner))
  .instructions(fs.text('.harness/prompts/candidate-arbiter.md'))
  .input(
    P.SpeculationInputSchema(
      workItem,
      workReceipt,
      git.ScopeReceiptSchema,
      crossTester.reportSchema,
      z.union([normativeEscalation.schema, contractViolation.schema]),
    ),
  )
  .partitions((i) => Array.from(new Set(i.candidates.flatMap((c) => c.input.targetPartitions))))
  .output(arbiterVerdictSchema);

// Actor-level interrupt handler bound once on guardedWorker (receiving actorInput: workItem)
// and preserved automatically across .withPolicy() and .withTools() clones.
// Grants (including nested $esc.elevateLeaseWhen owner grants while $esc.resumeWith resumes leaseAdjudicator)
// are recorded on the outer guardedWorker's agent-frame.activeLeases and enclosing loop-frame.grantedLoopLeases.
// fs.allowWriteGlobs matches both exact normalized file paths and glob patterns.
export const guardedWorker = worker
  .withPolicy(workerBasePolicy)
  .onInterrupt(leaseRequest, ($intr) =>
    $intr
      .adjudicateWith(leaseAdjudicator, (item, req) => ({ item, request: req }))
      .onInterrupt(normativeEscalation, ($esc) =>
        $esc
          .ask(owner, ownerDecisionSchema)
          .elevateLeaseWhen(
            (decision) => decision.approveSpecMutation && decision.unlockedSpecFiles.length > 0,
            (decision) => fs.allowWriteGlobs(decision.unlockedSpecFiles),
          )
          .resumeWith(
            (decision) =>
              `Owner selected option '${decision.selectedOptionId}'. Note: ${decision.note ?? 'None'}`,
          ),
      )
      .elevateLeaseWhen(
        (_item, req, verdict) =>
          verdict.approved &&
          verdict.unlockedGlobs.length > 0 &&
          verdict.unlockedGlobs.every(
            (g) => /\.test\.tsx?$/.test(g) && req.requestedPaths.includes(g),
          ),
        (_item, _req, verdict) => fs.allowWriteGlobs(verdict.unlockedGlobs),
      )
      .resumeWith((_item, _req, verdict) => verdict.ruling),
  );

export const verifiedWorkerLoop = P.loop('verified-worker-loop')
  .input(workItem)
  .output(workReceipt)
  .partitions((item) => item.targetPartitions)
  .maxIterations(3)
  .preserveActorSession(true)
  .distillLessonsInto(repoLessons)
  .act('execute', guardedWorker)
  .evaluate('evaluate', evaluator, {
    mapInput: (item, candidate, scopeReceipt) => ({ item, candidate, scopeReceipt }),
    acceptWhen: (ev) => ev.accepted && ev.deficits.length === 0,
    feedbackMapper: (ev) => `Resolve these evaluation deficits:\n- ${ev.deficits.join('\n- ')}`,
  })
  .returnOutputFrom('execute');

// ============================================================================
// 8. Long-Horizon Coordinator
// ============================================================================

export const coordinator = P.agent('coordinator')
  .prefixGroup(engineeringPrefix)
  .model(opus)
  .topology(repoTopology)
  .rules(repoRules)
  .lessons(repoLessons, { recordOutcomes: false })
  .policy(coordinatorPolicy)
  .tools(fs.codingTools(runner), git.refReaderTools(runner))
  .instructions(fs.text('.harness/prompts/coordinator.md'))
  .input(workItem)
  .partitions((item) => item.targetPartitions)
  .output(workReceipt)
  .capabilities(($cap) =>
    $cap
      // 1. Downward warm-prefix fork ('shared-prefix-only') with deterministic break-even routing
      .fork('delegate-partition', verifiedWorkerLoop, ($f) =>
        $f
          .historyMode('shared-prefix-only')
          .requestSchema(forkRequestSchema)
          .mapInput((parentItem, req) => ({
            ref: parentItem.ref,
            title: `${parentItem.title} [${req.partition}]`,
            description: `${req.objective}\n\nContext:\n${req.contextNotes}`,
            routingTier: 'leaf-only' as const,
            targetPartitions: [req.partition],
            dependsOn: [],
          }))
          .modelRouting(($m) =>
            $m
              .inheritParentWithEffort('medium', {
                when: (_parentItem, req) => req.estimatedTurns <= 6,
              })
              .otherwisePool(workerModels),
          ),
      )

      // 2. Speculative tournament: parallel CoW worktrees + deferred escalation parking +
      // non-destructive contested escalation arbitration + AST cross-testing + cross-pollination
      .speculate('explore-candidates', ($s) =>
        $s
          .requestSchema(speculateRequestSchema)
          .worker(verifiedWorkerLoop)
          .branches(2, (parentItem, req) => [
            {
              ...parentItem,
              routingTier: 'leaf-only' as const,
              targetPartitions: [req.partition],
              description: `${req.problemStatement}\n\nImplement Strategy A:\n${req.strategyA}`,
            },
            {
              ...parentItem,
              routingTier: 'leaf-only' as const,
              targetPartitions: [req.partition],
              description: `${req.problemStatement}\n\nImplement Strategy B:\n${req.strategyB}`,
            },
          ])
          .crossVerifyWith(crossTester)
          .arbiter(candidateArbiter, {
            resolveDecision: (verdict) => verdict,
          })
          .refineWinnerWhen(
            (verdict) => verdict.decision === 'select-winner' && verdict.followUpDeficits.length > 0,
            verifiedWorkerLoop.withTools(git.candidateComparisonTools(runner)),
            (parentItem, verdict, candidates) => {
              const selectedWinnerIndex =
                verdict.decision === 'select-winner' ? verdict.winnerBranchIndex : 0;
              const followUpDeficits =
                verdict.decision === 'select-winner' ? verdict.followUpDeficits : [];
              const selectedWinner = candidates.find(
                (c): c is Extract<(typeof candidates)[number], { status: 'COMPLETED' }> =>
                  c.status === 'COMPLETED' && c.branchIndex === selectedWinnerIndex,
              );
              const completedLoser = candidates.find(
                (c): c is Extract<(typeof candidates)[number], { status: 'COMPLETED' }> =>
                  c.status === 'COMPLETED' && c.branchIndex !== selectedWinnerIndex,
              );
              const baseWinnerInput = selectedWinner?.input ?? parentItem;
              return {
                ...baseWinnerInput,
                routingTier: 'leaf-only' as const,
                description: [
                  baseWinnerInput.description,
                  ``,
                  `Apply cross-pollination deficits from speculative arbitration:`,
                  ...followUpDeficits.map((d) => `- ${d}`),
                  ...(completedLoser
                    ? [
                        `Losing branch (branchIndex: ${completedLoser.branchIndex}, git ref: ${completedLoser.scopeReceipt.headRef}) for inspection via candidateComparisonTools.`,
                        `Losing branch diff stat:\n${completedLoser.scopeReceipt.diffStat}`,
                      ]
                    : []),
                ].join('\n'),
              };
            },
          ),
      )

      // 3. Dynamic DAG mutation: spawns independent prerequisite tickets into engineeringLane with
      // head-of-line priority inheritance ('inherit-parent-with-boost'), yields the concurrency slot,
      // and syncs the root worktree onto the prerequisite's pinned headRef upon exit.
      .mutatePlan(($m) =>
        $m
          .canSpawnTasks(workItem, {
            maxSpawnedPerRun: 6,
            maxPrerequisiteDepth: 3,
            enforcePatch: { routingTier: 'leaf-only' },
            onPrerequisiteSpawned: 'suspend-and-yield-slot',
            priorityStrategy: 'inherit-parent-with-boost',
            resumeWhen: 'prerequisite-exit',
          })
          .canAddDependencies()
          .canUpdateTopologyContracts(repoTopology),
      )

      // 4. Exogenous escalation to owner with LeaseDelta elevation for PRODUCT_SPEC.md / openapi.yaml
      .escalate(normativeEscalation, ($esc) =>
        $esc
          .to(owner)
          .response(ownerDecisionSchema)
          .elevateLeaseWhen(
            (decision) => decision.approveSpecMutation && decision.unlockedSpecFiles.length > 0,
            (decision) => fs.allowWriteGlobs(decision.unlockedSpecFiles),
          ),
      ),
  )
  // 5. Upward Architectural Interrupt handler: suspends raising fork's ContinuationFrame[] stack +
  // pauses all sibling forks in repoTopology.affectedBy(v.partition) across all sibling phases,
  // returns a normal SUSPENDED_ON_INTERRUPT tool_result to the single coordinator timeline,
  // and mounts the native resumeFork tool for dirty-safe syncChild rebase and loop completion.
  .onChildInterrupt(contractViolation, ($intr) =>
    $intr
      .pauseSiblingForksInPartitions((v) => repoTopology.affectedBy(v.partition))
      .suspendAndReturnToParent(),
  )
  .beforeStop(verifySuite);

// ============================================================================
// 9. Delivery Executables (with Stacked-PR Base Branch Lineage), Adaptive Flow & Lane
// ============================================================================

const deliveryInputSchema = z.object({
  item: workItem,
  receipt: workReceipt,
  scopeReceipt: git.ScopeReceiptSchema,
});

const landChanges = git
  .commitAndPush('land-changes', {
    inputSchema: deliveryInputSchema,
    branch: ({ item }) => `fix/${item.ref}`,
    message: ({ item }) => `${item.ref}: ${item.title}`,
  })
  .runner(runner)
  .env({ GH_TOKEN: P.env('GITHUB_TOKEN') });

const checkExistingPr = local
  .command('check-existing-pr')
  .input(deliveryInputSchema)
  .output(z.boolean())
  .runner(runner)
  .stdin('closed')
  .env({ GH_TOKEN: P.env('GITHUB_TOKEN') })
  .argv(({ item }) => [
    'sh',
    '-c',
    'gh pr view "fix/$1" --json state -q \'.state == "OPEN" or .state == "MERGED"\' 2>/dev/null | grep -q \'^true$\' && echo true || echo false',
    '_',
    item.ref,
  ]);

const publishPr = local
  .command('publish-pr')
  .input(deliveryInputSchema)
  .runner(runner)
  .stdin('closed')
  .env({ GH_TOKEN: P.env('GITHUB_TOKEN') })
  .argv(({ item, receipt, scopeReceipt }) => [
    'gh', 'pr', 'create',
    '--base', scopeReceipt.baseBranch,
    '--head', `fix/${item.ref}`,
    '--title', `${item.ref}: ${item.title}`,
    '--body', receipt.summary,
  ])
  .unrepeatable(checkExistingPr, { key: ({ item }) => item.ref });

export const engineeringFlow = P.flow('adaptive-engineering')
  .input(workItem)
  .scope(workspace)
  .telemetry(fs.telemetry())
  .branch('execute-work', ($b) =>
    $b
      .output(workReceipt)
      // Route A: Deep / Multi-Partition Architectural Work -> Coordinator
      .when(
        (item) => item.routingTier === 'deep' || item.targetPartitions.length > 1,
        ($deep) => $deep.step('coordinate', coordinator),
      )
      // Route B: Pre-Scoped Prerequisite Ticket -> Verified Loop (snapshots & resets worktree if contractViolation promotes to coordinator)
      .when(
        (item) => item.routingTier === 'leaf-only',
        ($leaf) =>
          $leaf.step('leaf-execute', verifiedWorkerLoop, ($step) =>
            $step.onInterrupt(contractViolation, ($promote) =>
              $promote
                .onAbort(git.snapshotAndReset())
                .replaceWith(coordinator, (item, violation, telemetry) => ({
                  ...item,
                  routingTier: 'deep' as const,
                  targetPartitions: Array.from(
                    new Set([...item.targetPartitions, violation.partition]),
                  ),
                  description: [
                    item.description,
                    `--- ESCALATED CONTRACT VIOLATION (${violation.partition}) ---`,
                    `Broken invariant: ${violation.brokenInvariant}`,
                    `Proof: ${violation.proof}`,
                    `Proposed patch: ${violation.proposedPatch}`,
                    `Aborted snapshot ref (inspect via git.refReaderTools): ${telemetry.abortMeta?.abortedSnapshotRef ?? 'none'}`,
                  ].join('\n'),
                })),
            ),
          ),
      )
      // Route C: Default 'auto' -> Evaluated Fast-Path (verifiedWorkerLoop with fastPathPolicy)
      // Small tasks pass both verifySuite and evaluator; scopeTripwire or contractViolation snapshots & promotes to coordinator.
      .otherwise(($fast) =>
        $fast.step('fast-attempt', verifiedWorkerLoop.withPolicy(fastPathPolicy), ($step) =>
          $step
            .onInterrupt(scopeTripwire, ($promote) =>
              $promote
                .onAbort(git.snapshotAndReset())
                .replaceWith(coordinator, (item, tripwire, telemetry) => ({
                  ...item,
                  routingTier: 'deep' as const,
                  targetPartitions: tripwire.implicatedPartitions,
                  description: [
                    item.description,
                    `--- FAST-PATH RECONNAISSANCE ---`,
                    `Reason aborted: ${tripwire.reason}`,
                    `Partitions implicated: ${tripwire.implicatedPartitions.join(', ')}`,
                    `Files inspected: ${telemetry.custom.filesRead.join(', ')}`,
                    `Aborted snapshot ref (inspect via git.refReaderTools): ${telemetry.abortMeta?.abortedSnapshotRef ?? 'none'}`,
                    `Findings: ${tripwire.findings}`,
                  ].join('\n'),
                })),
            )
            .onInterrupt(contractViolation, ($promote) =>
              $promote
                .onAbort(git.snapshotAndReset())
                .replaceWith(coordinator, (item, violation, telemetry) => ({
                  ...item,
                  routingTier: 'deep' as const,
                  targetPartitions: Array.from(
                    new Set([...item.targetPartitions, violation.partition]),
                  ),
                  description: [
                    item.description,
                    `--- FAST-PATH CONTRACT VIOLATION (${violation.partition}) ---`,
                    `Broken invariant: ${violation.brokenInvariant}`,
                    `Proof: ${violation.proof}`,
                    `Proposed patch: ${violation.proposedPatch}`,
                    `Files inspected: ${telemetry.custom.filesRead.join(', ')}`,
                    `Aborted snapshot ref (inspect via git.refReaderTools): ${telemetry.abortMeta?.abortedSnapshotRef ?? 'none'}`,
                  ].join('\n'),
                })),
            ),
        ),
      ),
  )
  .step('push', landChanges, ($s) =>
    $s.inputFrom((item, steps, scopeReceipt) => ({
      item,
      receipt: steps['execute-work'],
      scopeReceipt,
    })),
  )
  .step('publish', publishPr, ($s) =>
    $s.inputFrom((item, steps, scopeReceipt) => ({
      item,
      receipt: steps['execute-work'],
      scopeReceipt,
    })),
  )
  .exit('done');

const issuesTracker = github.issues({ repo: 'acme/app', token: P.env('GITHUB_TOKEN') });

export const engineeringLane = P.lane('engineering')
  .input(workItem)
  .key((i) => i.ref)
  .tracker(issuesTracker, ($) =>
    $
      .everySeconds(60)
      .from((issue) => {
        if (!issue.labels.includes('agent-ready')) return undefined;

        const partitions = issue.labels
          .filter((l): l is `partition:${z.infer<typeof partitionEnum>}` =>
            /^partition:(db|api|web)$/.test(l),
          )
          .map((l) => l.replace('partition:', '') as z.infer<typeof partitionEnum>);

        const hasDeepLabel = issue.labels.some((l) => ['epic', 'architecture', 'deep'].includes(l));
        const routingTier = hasDeepLabel || partitions.length > 1 ? 'deep' : 'auto';

        return {
          ref: `#${issue.number}`,
          title: issue.title,
          description: issue.body ?? '',
          routingTier,
          targetPartitions: partitions,
          dependsOn: [],
        };
      })
      .onQueued('queued')
      .onRunning('in-progress')
      .onWaiting('needs-human')
      .onErrored('errored')
      .onCancelled('cancelled')
      .onExit('done', 'pr-open')
      .onExit('abandoned', 'needs-triage')
      .onExit('exhausted', 'needs-triage'),
  )
  .flow(engineeringFlow)
  .concurrency(4)
  .priority('high')
  .agingMinutes(30)
  .waitFor((i) => i.dependsOn, 'abandoned')
  .maxCostUsd(
    20,
    owner
      .withName('budget-approver')
      .output(P.BudgetApprovalSchema),
  )
  .retry(($) => $.tries(2).exponential(5_000).orFail('exhausted'))
  .onSignal(steerSignal, ($) =>
    $
      .update((cur, sig) => ({
        ...cur,
        routingTier: 'deep' as const,
        description: `${cur.description}\n\nOwner steering note: ${sig.note}`,
      }))
      .rewindTo('execute-work', { onRewind: git.keepWorktree() }),
  );

export const appHarness = P.harness('acme-engineering')
  .ledger(ledger)
  .pools(claudeAccounts, workerModels, runner)
  .streams(githubMergeStream, githubPrClosedStream)
  .lanes(engineeringLane)
  .onSignal(highLeverageLessonSignal, ($sig) =>
    $sig.notify(owner, (s) =>
      `High-leverage lesson [${s.lessonId}] in partition '${s.partition ?? 'global'}' ` +
      `(${s.cleanPassCount} clean passes, ${s.violatedCount} violations):\n"${s.directive}"\n` +
      `Consider promoting to repoRules or a deterministic check.`,
    ),
  )
  .expose(
    mcp.server({ port: 9100 }),
    slackBot,
  );
~~~