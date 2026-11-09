# Unified Memory Harness (`@paraharness/memory`) — Implementation Plan

This document slices the implementation and verification of `@paraharness/memory` (`packages/memory/`) specified in [`docs/unified-memory/UNIFIED_MEMORY_SPEC.md`](./UNIFIED_MEMORY_SPEC.md) (`lines 1–1909`) and [`docs/CODING_GUIDELINES.md`](../CODING_GUIDELINES.md) (`§§1–6`) into two bottom-up, zero-stub waves (`UM-1` $\to$ `UM-2`) executed under [`docs/unified-memory/UM_IMPL_LOOP.md`](./UM_IMPL_LOOP.md).

---

## 1. Scope, Ownership & Approved Dependencies

### 1.1 Wave Ownership Matrix (`owned_dirs` & `forbidden_dirs`)

Every file authored in `UM-1` and `UM-2` must be 100% complete upon creation (**zero stubbed functions, methods, or branches** in either wave):

| Unit | Wave | Owned Files & Directories (`owned_dirs` — Read/Write) | Forbidden Directories (`forbidden_dirs` — Zero Touch) |
| :--- | :--- | :--- | :--- |
| **`UM-1`** | **Wave 1: Schemas, Port Contracts, Pure Domain Engines, Atomic Ledger & Git/Epoch Primitives** | `packages/memory/{package.json,tsconfig.json,tsconfig.build.json,README.md,LICENSE}`, `packages/memory/src/schemas/**`, `packages/memory/src/memory-harness-error.ts`, `packages/memory/src/memory-distiller-runner.ts`, `packages/memory/src/memory-harness-options.ts`, `packages/memory/src/memory-harness-contract.ts`, `packages/memory/src/internal/**`, `packages/memory/src/index.ts`, `packages/memory/test/fixtures/**`, `packages/memory/test/{config-and-matching.test.ts,caps-and-lifecycles.test.ts,git-sync-and-reconcile.test.ts}`, `tsconfig.base.json`, `pnpm-lock.yaml` | `packages/{lockfile,core,sqlite,postgres,fs,markdown,node,git,claude,openai,gemini,github,slack,stripe,netsuite,integration}/**`, `package.json`, `eslint.config.mjs`, `vitest.config.ts`, `.agents/**`, `.claude/**`, `docs/**` |
| **`UM-2`** | **Wave 2: `MemoryHarness` Coordinator, 5 Tools, Compaction-Epoch Hook & End-to-End Integration** | `packages/memory/src/memory-harness.ts`, `packages/memory/src/internal/**`, `packages/memory/src/index.ts`, `packages/memory/test/{tools-propose-commit-drain.test.ts,file-interaction-hook.test.ts}` | All other `packages/*/**`, root workspace configs, `.agents/**`, `.claude/**`, `docs/**` |

### 1.2 Approved External Libraries & Native Primitives (`CLAUDE.MD` #2 & `docs/CODING_GUIDELINES.md` Rule 3.5)

All runtime and development dependencies are already approved and locked in `pnpm-lock.yaml`:

| Concern | Selected Package / Built-in | Version & License | Grounded Usage in `@paraharness/memory` |
| :--- | :--- | :--- | :--- |
| Cross-process & in-process advisory file locking | `@paraharness/lockfile` (`withFileLock`) | `workspace:*` (`MIT`) | Acquires `.memory/.session-state/<sessionId>.lock`, `latest-role.lock`, and `<ledgerPath>.lock` in strict §8.1 lock order with `try / finally` release |
| Crash-safe atomic file writes | `write-file-atomic` (`+ @types/write-file-atomic`) | `^8.0.0` (`ISC`) | Atomically writes `memory.meta.json`, `memory.jsonl`, `latest-role.json`, and `<sessionId>.json` in strict §8.1 Rule 2 multi-file order |
| Pre-compiled glob path matching | `picomatch` (`+ @types/picomatch`) | `^4.0.3` (`MIT`) | Pre-compiles matchers (`{ dot: true }`) for `matchesContextScope` (§4.3) and `isContextCoveredByCapPattern` (§5.2) |
| Fast workspace file listing (`repoFiles`) | `tinyglobby` (`glob`) | `^0.2.17` (`MIT`) | Enumerates workspace files (`dot: true`, ignoring `.git/**`, `node_modules/**`, `.memory/.session-state/**`) when evaluating directory/glob intersections |
| Runtime schema validation & JSON Schema export | `zod` (`z`, `z.toJSONSchema`) | `^4.6.7` (`MIT`) | Validates config, ledger records, metadata, tool inputs/outputs, and exports `DistillerStructuredOutputSchema` JSON Schema |
| Subprocess & filesystem primitives | `node:child_process` (`execFile`), `node:fs/promises`, `node:path` | Node `>=22.0.0` built-ins | Executes `claude -p` CLI runner (§6.4) and `git -C <checkoutDir>` commands (§8.2) with explicit `timeout` and `AbortSignal` cleanup |

---

## 2. Normative Specification Grounding (`docs/unified-memory/UNIFIED_MEMORY_SPEC.md`)

| Unit | Spec Sections & Exact Line Ranges | Grounded Deliverables |
| :--- | :--- | :--- |
| **`UM-1`** | `§1.1–§1.2` (`lines 3–45`), `§2.1–§2.2` (`lines 47–395`), `§3.1–§3.3` (`lines 397–579`), `§4.1–§4.3` (`lines 581–644`), `§5.1–§5.3` (`lines 646–712`), `§6.1–§6.7` schemas & pure helpers (`lines 714–1526`), `§7.1–§7.2` schemas & epoch/path helpers (`lines 1528–1650`), `§8.1–§8.2` (`lines 1652–1708`), `§9.1–§9.2` (`lines 1710–1894`) | Package manifest (`packages/memory/package.json`, `tsconfig.json`, `tsconfig.build.json`), all Zod v4 schemas (`memory-config.schema.ts`, `memory-record.schema.ts`, `memory-tools.schema.ts`), port/contract interfaces & error class (`MemoryDistillerRunner`, `MemoryHarnessOptions`, `MemoryHarnessContract`, `MemoryHarnessError`), and all 13 `src/internal/*` domain/storage/Git/epoch modules (`load-memory-config.ts`, `normalize-memory-path-pattern.ts`, `matches-context-scope.ts`, `resolve-record-cap-bucket.ts`, `validate-lesson-text-format.ts`, `evaluate-note-lifecycle-on-read.ts`, `read-memory-ledger.ts`, `write-memory-ledger.ts`, `build-memory-protocol.ts`, `build-distiller-prompts.ts`, `reconcile-diverged-memory-ledgers.ts`, `sync-memory-git.ts`, `resolve-session-epoch-state.ts`), plus `src/index.ts` re-exports of all `UM-1` public symbols. |
| **`UM-2`** | `§6.1–§6.7` (`lines 714–1526`), `§7.1–§7.2` (`lines 1528–1650`), `§8.1–§8.2` (`lines 1652–1708`), `§9.1–§9.2` (`lines 1710–1894`) | Full `MemoryHarness` stateful coordinator class (`src/memory-harness.ts` and any dedicated `src/internal/*` tool/hook phase coordinators) implementing `MemoryHarnessContract` (`init`, `loadScoped`, `propose` with both `resolved` and `delegate_to_subagent` modes + `claude -p` CLI fallback, `commit`, `drainNotes`, and `handleFileInteractionHook`), re-exported from `src/index.ts`, plus complete end-to-end tool and hook test suites (`tools-propose-commit-drain.test.ts`, `file-interaction-hook.test.ts`). |

---

## 3. Planned Single-Kind Module Decomposition (`packages/memory/src/`)

Every file, class, method, and function in `packages/memory/src/**` and `packages/memory/test/fixtures/**` obeys [`docs/CODING_GUIDELINES.md`](../CODING_GUIDELINES.md) §§1–5: single-kind entity files (`Rules 1.1–1.8`), complete `/** ... */` JSDoc with `@param`, `@returns`, `@throws` tags (`Rules 2.1–2.3`), zero inline or body comments (`Rule 2.4`), single responsibility at one level of abstraction (`Rule 3.1`), flat guard clauses (`Rule 3.2`), named `*Params`/`*Options` interfaces when parameters exceed `3` (`Rule 3.3`), pre-compiled `picomatch`/`RegExp` instances (`Rule 4.4`), and strict `: any` / `as any` / `!` prohibition (`Rule 5.1`). Builders are free and expected to extract additional focused `src/internal/*` helper files whenever responsibilities separate while preserving all public exports in `src/index.ts`.

| File Path | Entity Kind (`Rule 1.1`) | Wave | Exported Symbols & Single Responsibility |
| :--- | :---: | :---: | :--- |
| `src/schemas/memory-config.schema.ts` | `*.schema.ts` | `UM-1` | `MemoryGitStorageConfigSchema`, `MemoryStorageConfigSchema`, `MemoryCapRuleSchema`, `MemoryLessonFormatConfigSchema`, `MemoryDistillerConfigSchema`, `MemoryConfigSchema` and inferred types (§2.2). |
| `src/schemas/memory-record.schema.ts` | `*.schema.ts` | `UM-1` | `MemoryRecordTypeSchema`, `NoteLifecycleModeSchema`, `NoteLifecycleSchema`, `MemoryRuleRecordSchema`, `MemoryLessonRecordSchema`, `MemoryNoteRecordSchema`, `MemoryRecordSchema`, `MemoryMetaSchema` and inferred types (§3.2). |
| `src/schemas/memory-tools.schema.ts` | `*.schema.ts` | `UM-1` | `SessionIdSchema`, `MemoryLoadedRuleOrLessonRecordSchema`, `MemoryLoadedNoteRecordSchema`, `MemoryBucketStatusSchema`, `MemoryErrorCodeSchema`, `MemoryInitInputSchema`, `MemoryInitOutputSchema`, `MemoryLoadScopedInputSchema`, `MemoryLoadScopedOutputSchema`, `MemoryCapMergeProposalSchema`, `DistillerChoiceOutputSchema`, `MemoryProposalChoiceSchema`, `DistillerStructuredOutputSchema`, `MemoryProposeInputSchema`, `MemoryProposeOutputSchema`, `MemoryCommitInputSchema`, `MemoryCommitOutputSchema`, `MemoryDrainNotesInputSchema`, `MemoryDrainNotesOutputSchema`, `FileInteractionHookInputSchema`, `FileInteractionHookOutputSchema`, `MemoryLatestRoleStateSchema`, `MemorySessionEpochStateSchema` and inferred types (§§6.1–6.6, §7.1–§7.2). |
| `src/memory-distiller-runner.ts` | `interface` | `UM-1` | `MemoryDistillerRunner` and reachable `DistillerProposalRequest` sub-interface (§9.1, `Rule 1.2`). |
| `src/memory-harness-options.ts` | `interface` | `UM-1` | `MemoryHarnessOptions` configuration and dependency injection interface (§9.1). |
| `src/memory-harness-contract.ts` | `interface` | `UM-1` | `MemoryHarnessContract` programmatic surface interface with complete `@param`, `@returns`, `@throws` JSDoc (§9.1). |
| `src/memory-harness-error.ts` | `class` | `UM-1` | `MemoryHarnessError` domain error carrying `readonly code: MemoryErrorCode` and `readonly details?: Readonly<Record<string, unknown>>` (§9.1). |
| `src/internal/load-memory-config.ts` | `function` | `UM-1` | `loadMemoryConfig`: discovers `.agents/memory.config.json` $\to$ `.claude/memory.config.json`, validates via `MemoryConfigSchema`, and pre-compiles `forbidRegexes` (§2.1). |
| `src/internal/normalize-memory-path-pattern.ts` | `function` | `UM-1` | `normalizeMemoryPathPattern`, `normalizeMemoryPathArray`: strips `workspaceRoot`, normalizes `.` / `./` to `'**/*'`, rejects `'..'` and external absolute paths, and deduplicates in first-seen order (§4.1). |
| `src/internal/matches-context-scope.ts` | `function` | `UM-1` | `isGlobPattern`, `extractStaticDirPrefix`, `buildRelativeProbes`, `isDirectoryCandidate`, `matchSingleContextPair`, `matchesContextScope`: 4-way symmetric path/glob matching (§4.2–§4.3). |
| `src/internal/resolve-record-cap-bucket.ts` | `function` | `UM-1` | `isRecordActiveForRepo`, `isContextCoveredByCapPattern`, `isCapRuleEligibleForRecord`, `resolveRecordCapBucket`: 6-tuple specificity ranking and 3-zone capacity computation (§5.1–§5.3). |
| `src/internal/validate-lesson-text-format.ts` | `function` | `UM-1` | `validateLessonTextFormat`: 5-step deterministic string, single-sentence, `' because '` clause length, and pre-compiled `forbidRegexes` gate (§6.7). |
| `src/internal/evaluate-note-lifecycle-on-read.ts` | `function` | `UM-1` | `evaluateNoteLifecycleOnRead`: evaluates `persistent`, `read-count` (without mutating `updatedAt`), `hard-expiry`, and `soft-expiry` transitions (§3.3). |
| `src/internal/read-memory-ledger.ts` | `function` | `UM-1` | `readMemoryLedger`: parses `memory.jsonl` and `memory.meta.json`, reconciles monotonic `highWaterMarks` across raw records before expiry, and purges expired `hard-expiry` notes (§3.1, §3.3). |
| `src/internal/write-memory-ledger.ts` | `function` | `UM-1` | `writeMemoryLedger`: canonical-sorts records (`R*` $\to$ `L*` $\to$ `N*`) and atomically persists `memory.meta.json` first and `memory.jsonl` second via `write-file-atomic` (§3.1, §8.1). |
| `src/internal/build-memory-protocol.ts` | `function` | `UM-1` | `buildMemoryProtocol`: generates the config-adapted `protocol` markdown instructions returned by `memory_init` (§6.2). |
| `src/internal/build-distiller-prompts.ts` | `function` | `UM-1` | `buildDistillerPrompts`: constructs the byte-identical KV-cacheable `systemPrompt` and dynamic `userPrompt` for `memory_propose` (§6.4). |
| `src/internal/reconcile-diverged-memory-ledgers.ts` | `function` | `UM-1` | `reconcileDivergedMemoryLedgers`: pure 3-way record merge, monotonic ID collision re-numbering, `read-count` delta subtraction, and `highWaterMarks` union (§8.2.3). |
| `src/internal/sync-memory-git.ts` | `function` | `UM-1` | `ensureMemoryGitCheckout`, `syncMemoryGit`, `remapOtherSessionStatesAfterLockRelease`: in-place `.memory` Git checkout, session-start `autoPullOnInit`, fallback-author auto-commit, 3-way diverged push retry loop, pre-op `CAP_EXCEEDED` rollback, and post-lock other-session `seenRecordIds` remapping (§8.2). |
| `src/internal/resolve-session-epoch-state.ts` | `function` | `UM-1` | `resolveSessionEpochState`, `extractTouchedPathsFromHookInput`: Claude Code & Antigravity hook path/glob extraction, incremental `transcript.jsonl` compaction-checkpoint & role scanner, and `<sessionId>.json` / `latest-role.json` persistence (§7.1–§7.2). |
| `src/memory-harness.ts` | `class` | `UM-2` | `MemoryHarness` stateful coordinator implementing `MemoryHarnessContract` (`init`, `loadScoped`, `propose`, `commit`, `drainNotes`, `handleFileInteractionHook`) and delegating domain phases to `src/internal/*` (§9.1, `Rules 1.3, 3.1`). |
| `src/index.ts` | Barrel | `UM-1` (schemas, interfaces, `MemoryHarnessError`) $\to$ `UM-2` (adds `MemoryHarness`) | Pure explicit `export` and `export type` surface of `@paraharness/memory` (`Rule 1.7`). |

---

## 4. Deterministic Test Suite Matrix (`packages/memory/test/`)

All `test/fixtures/**` files strictly obey single-entity-kind file separation (`Rule 1.1`), single responsibility (`Rule 3.1`), and complete §2 JSDoc:

| File Path | Category | Wave | Required Deterministic Test Cases |
| :--- | :---: | :---: | :--- |
| `test/fixtures/temp-memory-workspace-handle.ts` | `fixture (interface)` | `UM-1` | Dedicated single-`interface` file (`TempMemoryWorkspaceHandle`) exposing `workspaceRoot`, `writeConfig`, `cleanup`, and helper paths. |
| `test/fixtures/create-temp-memory-workspace.ts` | `fixture (function)` | `UM-1` | Single-`function` helper (`createTempMemoryWorkspace` + co-located `TempMemoryWorkspaceOptions`) creating real temporary workspaces with `.agents/memory.config.json` and seeded files. |
| `test/fixtures/fake-memory-distiller-runner.ts` | `fixture (class)` | `UM-1` | Single-`class` test double (`FakeMemoryDistillerRunner` implementing `MemoryDistillerRunner`) recording received `DistillerProposalRequest` payloads and returning deterministic `DistillerStructuredOutput` responses. |
| `test/config-and-matching.test.ts` | `test` | `UM-1` | Verifies `.agents/memory.config.json` $\to$ `.claude/memory.config.json` discovery, `CONFIG_NOT_FOUND` & `CONFIG_VALIDATION_FAILED` (`duplicate roles/types`, `'./'`/`'C:'` cap paths, `ledgerPath` outside `checkoutDir`, invalid `forbidRegexes`), `normalizeMemoryPathPattern` (`workspaceRoot` stripping, `.` $\to$ `'**/*'`, `'/'` outside root rejection, deduplication), `validateLessonTextFormat`, and all 4 cases of `matchesContextScope` (including compound extensions `.schema.ts`, exact basenames `SKILL.md`, mid-segment globs, `isDirectoryCandidate` file-vs-dir guard, and `repoFiles` check). |
| `test/caps-and-lifecycles.test.ts` | `test` | `UM-1` | Verifies `isContextCoveredByCapPattern` (ensuring file-restricted cap rules like `**/*.test.ts` never capture broad directory records `packages/foo/**`), 6-tuple specificity ranking `(pathTier, maxPrefixSegments, maxPrefixChars, roleSpec, typeSpec, -i)`, `UNCAPPED` / `UNDER_SOFT_CAP` / `SOFT_CAP_PRESSURE` / `AT_HARD_CAP` zones (including `maxTotalRecordsReached`), pre-purge monotonic `highWaterMarks` self-healing in `readMemoryLedger` / `writeMemoryLedger`, and all 4 note lifecycles in `evaluateNoteLifecycleOnRead` (`persistent`, `read-count` decrement without advancing `updatedAt` + final-read `[FINAL READ - DRAINED]` deletion, `hard-expiry` silent purge, and `soft-expiry` final-read deletion). |
| `test/git-sync-and-reconcile.test.ts` | `test` | `UM-1` | Verifies against real local bare & working Git repositories (`git init --bare`): in-place `ensureMemoryGitCheckout` with pre-existing `.session-state/` and pre-existing local `memory.jsonl` reconciled against `origin/main`, session-start `autoPullOnInit` 3-way reconciliation (and non-throwing fallback when offline), fallback-author `autoCommit`, concurrent diverged multi-repo `autoPush` 3-way reconciliation (`reconcileDivergedMemoryLedgers`), monotonic ID collision re-numbering, transitive `cumulativeIdRemap` propagation and post-lock `<otherSid>.json` remapping, `read-count` delta subtraction, and pre-operation state rollback on post-push `CAP_EXCEEDED`. |
| `test/tools-propose-commit-drain.test.ts` | `test` | `UM-2` | Verifies `MemoryHarness` tools end-to-end: `memory_init` (unscoped loading, `latest-role.json`, `<sessionId>.json` `PENDING_HOOK_EPOCH`, generated `protocol`), `memory_load_scoped` (scoped loading, `seenRecordIds` tracking), `memory_propose` (byte-identical KV-cached `systemPrompt`, `resolved` vs `delegate_to_subagent`, `<ledgerPath>.lock` released before runner execution, choice validation & hydration), `memory_commit` (`add`, `update` with `context: null` / `repos: null` widening and `alsoRemoveIds`, `remove`, `capMerge` same-role/same-type & unioned scope, `RULE_PROTECTION_VIOLATION`, `LESSON_FORMAT_INVALID`, `CAP_EXCEEDED`, plus Git `cumulativeIdRemap` output remapping), and `memory_drain_notes` (`dryRun: true` vs `false` across mode/role/path/ID filters). |
| `test/file-interaction-hook.test.ts` | `test` | `UM-2` | Verifies `MemoryHarness.handleFileInteractionHook` end-to-end: Claude Code (`Read`, `Edit`, `MultiEdit`, `Write`, `NotebookEdit`, `Glob`, `Grep` with raw `path + glob` join and `pattern` exclusion) & Antigravity (`read_file`, `edit_file`, `find_by_name`, `grep_search` with `Includes` join and `Query` exclusion) extraction, external-path early exit, `<sessionId>.lock` $\to$ `<ledgerPath>.lock` ordering, `PENDING_HOOK_EPOCH` preservation of post-init `seenRecordIds`, incremental `transcript.jsonl` compaction-checkpoint scanning & epoch reset on compaction boundary, role fallback precedence (`transcript memory_init` $\to$ non-general `state.role` $\to$ `latest-role.json` $\to$ `'general'`), and unseen-only note lifecycle drainage. |

---

## 5. Scoped Verification Gate Commands (`gate_cmd`)

Run from the workspace root:

```bash
pnpm --filter @paraharness/memory lint
pnpm --filter @paraharness/memory typecheck
pnpm --filter @paraharness/memory test -- --reporter=verbose
```
