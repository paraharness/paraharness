# Milestone 3a (`M3a`): `@harness-dsl/sqlite` & `@harness-dsl/postgres` Storage Adapters

## 1. Scope & Package Directory

- **Milestone Wave:** Parallel Wave 2 — Scoped Adapter Builder (`c`) (Depends on Wave 1a `M1` -> Wave 1b `M2` completing)
- **Owned Files & Directories:**
  - `packages/sqlite/src/schema.ts`
  - `packages/sqlite/src/ledger-store.ts`
  - `packages/sqlite/src/topology-store.ts`
  - `packages/sqlite/src/lesson-store.ts`
  - `packages/sqlite/src/rule-store.ts`
  - `packages/sqlite/src/merge3.ts`
  - `packages/sqlite/src/index.ts`
  - `packages/sqlite/test/ledger-store.test.ts`
  - `packages/sqlite/test/topology-store.test.ts`
  - `packages/sqlite/test/lesson-rule-store.test.ts`
  - `packages/postgres/src/ledger-store.ts`
  - `packages/postgres/src/topology-store.ts`
  - `packages/postgres/src/lesson-store.ts`
  - `packages/postgres/src/rule-store.ts`
  - `packages/postgres/src/index.ts`
  - `packages/postgres/test/postgres-stores.test.ts`
- **Forbidden Directories:**
  - Do not modify root workspace files (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `pnpm-lock.yaml`) or `packages/core/**`.
  - Do not touch `packages/fs`, `packages/markdown`, `packages/node`, `packages/git`, `packages/claude`, `packages/openai`, `packages/github`, `packages/slack`, `packages/stripe`, `packages/netsuite`, or `packages/integration`.
  - Zero cross-adapter imports: `packages/sqlite` imports only from `@harness-dsl/core`, `zod`, `better-sqlite3`, and Node.js built-ins (`node:crypto`, `node:path`, `node:fs`, `node:sqlite`); `packages/postgres` imports only from `@harness-dsl/core`, `zod`, and Node.js built-ins (`node:crypto`, `node:path`, `node:fs`).

---

## 2. Exact Spec Grounding Table

Read the following sections in full before authoring any file in `M3a`:

| Document | Section | Line Range | Key Contracts & Storage Semantics Covered |
| :--- | :--- | :--- | :--- |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §1.1 Package Boundaries & §1.2 Invariant 5 | `20–21, 31` | Local WAL-mode SQLite & PostgreSQL storage responsibilities; Host-Root Storage Port Resolution |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §2.6 Storage Ports (`LedgerStore`, `TopologyStore`, `LessonStore`) | `430–829` | Exact method signatures and behavioral contracts for `LedgerStore`, `TopologyStore`, `LessonStore` |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §3.3 Relational System Topology (`H.topology`) | `949–960` | Run-scoped CoW overlays, `baseContractTextAtAcquire` pinning, `stepExecId` tagging, `syncRunOverlays`, `resetRunOverlay` (`step` vs `run`), `sealRunOverlay`, monotonic 3-way `commitRunOverlay`, `discardRunOverlay` |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §3.4.1 Rules & §3.4.3 Lessons | `963–1030` | `GlobalRule` relational `Source`, `LessonStore` BM25 similarity $R(L, Q) \in [0, 1]$, `syncCreationEpochsForRuns`, `markSignalEmitted`, `retire` |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §3.10 Ledger Compaction (`.compactWhen()`) | `1359` | Persisted compaction deadlines, stacked-PR `baseBranch !== 'main'` deferral, active `itemKey` protection |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §4.5 Adapter Specifications | `1465–1471` | `sqlite.ledger`, `sqlite.topologyStore`, `sqlite.lessonStore`, `sqlite.globalRules`, `postgres.*` |
| [`docs/CODING_SAMPLE.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_SAMPLE.md) | §6 `engineering-harness.ts` | `344–355, 457–475, 554` | Exact builder invocations for `sqlite.ledger(...).compactWhen(...)`, `sqlite.topologyStore(...)`, `sqlite.globalRules(..., { table })` |

---

## 3. File-by-File Architecture & Exported Symbols

### 3.1 `packages/sqlite/src/index.ts` & `packages/postgres/src/index.ts`

```ts
import type {
  CompactionRuleConfig,
  CompactionSignalRuleConfig,
  ConfigurableLedgerStore,
  GlobalRule,
  LedgerCompactionBuilder,
  LedgerStore,
  LessonStore,
  SignalDef,
  Source,
  TopologyStore,
} from '@harness-dsl/core';

export type {
  CompactionRuleConfig,
  CompactionSignalRuleConfig,
  ConfigurableLedgerStore,
  LedgerCompactionBuilder,
};

export interface PgPoolLike {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, any>[] }>;
  close?(): Promise<void>;
}

export const sqlite: {
  ledger(uri: string, opts?: { readonly hostRootDir?: string }): ConfigurableLedgerStore;
  topologyStore(uri: string, opts?: { readonly hostRootDir?: string }): TopologyStore;
  lessonStore(uri: string, opts?: { readonly hostRootDir?: string }): LessonStore;
  globalRules(uri: string, opts: { readonly table: string; readonly hostRootDir?: string }): Source<GlobalRule[]>;
  rules(uri: string, opts: { readonly table: string; readonly hostRootDir?: string }): Source<GlobalRule[]>;
};

export const postgres: {
  ledger(uri: string, opts?: { readonly pool?: PgPoolLike }): ConfigurableLedgerStore;
  topologyStore(uri: string, opts?: { readonly pool?: PgPoolLike }): TopologyStore;
  lessonStore(uri: string, opts?: { readonly pool?: PgPoolLike }): LessonStore;
  globalRules(uri: string, opts: { readonly table: string; readonly pool?: PgPoolLike }): Source<GlobalRule[]>;
  rules(uri: string, opts: { readonly table: string; readonly pool?: PgPoolLike }): Source<GlobalRule[]>;
};
```

### 3.2 `packages/sqlite/src/schema.ts`

Initializes SQLite connection in WAL mode (`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;`) and creates all tables idempotently:
- `harness_runs`: `run_id TEXT PRIMARY KEY`, `lane_id TEXT NOT NULL`, `item_key TEXT NOT NULL`, `status TEXT NOT NULL`, `current_step_id TEXT`, `input_json TEXT NOT NULL`, `rewind_pending_to_step_id TEXT`, `compiled_prefixes_json TEXT`, `cost_usd REAL NOT NULL DEFAULT 0`, `approved_max_cost_usd REAL`, `terminal_state TEXT`, `scope_receipt_json TEXT`, `updated_at TEXT NOT NULL`.
- `harness_steps`: `step_exec_id TEXT PRIMARY KEY`, `run_id TEXT NOT NULL`, `step_id TEXT NOT NULL`, `status TEXT NOT NULL`, `input_msg_id TEXT`, `base_scope_checkpoint TEXT`, `head_scope_checkpoint TEXT`, `output_json TEXT`, `telemetry_json TEXT`, `pending_tool_batch_json TEXT`, `continuation_stack_json TEXT NOT NULL`, `started_at TEXT NOT NULL`, `updated_at TEXT NOT NULL`.
- `harness_messages`: `message_id TEXT PRIMARY KEY`, `run_id TEXT NOT NULL`, `parent_message_id TEXT`, `vendor_id TEXT NOT NULL`, `raw_wire_frame BLOB NOT NULL`, `canonical_json TEXT NOT NULL`, `prefix_digest TEXT NOT NULL`, `compacted_tombstones_json TEXT`, `is_pruned INTEGER NOT NULL DEFAULT 0`, `created_at TEXT NOT NULL`.
- `harness_suspended_forks`: `suspended_fork_id TEXT PRIMARY KEY`, `fork_id TEXT NOT NULL`, `suspension_epoch INTEGER NOT NULL`, `run_id TEXT NOT NULL`, `parent_step_exec_id TEXT NOT NULL`, `fork_tool_name TEXT NOT NULL`, `active_partitions_json TEXT NOT NULL`, `suspension_reason TEXT NOT NULL`, `triggered_by_fork_id TEXT`, `raised_by_phase TEXT`, `conflict_retry_count INTEGER NOT NULL`, `conflict_check_armed INTEGER NOT NULL`, `synced_to_parent_checkpoint TEXT`, `sync_result_json TEXT`, `resume_frame_injected INTEGER NOT NULL DEFAULT 0`, `interrupt_id TEXT`, `interrupt_payload_json TEXT`, `suspended_at_call_id TEXT`, `child_scope_checkpoint TEXT`, `continuation_stack_json TEXT NOT NULL`, `resolution_status TEXT NOT NULL DEFAULT 'OPEN'`.
- `harness_compaction_deadlines`: `run_id TEXT PRIMARY KEY`, `item_key TEXT NOT NULL`, `compact_after TEXT NOT NULL`, `awaiting_base_branch TEXT`, `compacted INTEGER NOT NULL DEFAULT 0`.
- `topology_base_partitions`: `partition_id TEXT PRIMARY KEY`, `epoch INTEGER NOT NULL`, `contract_text TEXT NOT NULL`, `updated_at TEXT NOT NULL`.
- `topology_run_overlays`: `run_id TEXT NOT NULL`, `partition_id TEXT NOT NULL`, `status TEXT NOT NULL DEFAULT 'ACTIVE'`, `base_contract_text_at_acquire TEXT NOT NULL`, `synced_contract_text TEXT NOT NULL`, ` synced_epoch INTEGER NOT NULL`, `current_contract_text TEXT NOT NULL`, `current_epoch INTEGER NOT NULL`, `updated_at TEXT NOT NULL`, `PRIMARY KEY (run_id, partition_id)`.
- `topology_overlay_step_mutations`: `id INTEGER PRIMARY KEY AUTOINCREMENT`, `run_id TEXT NOT NULL`, `step_exec_id TEXT NOT NULL`, `partition_id TEXT NOT NULL`, `prev_contract_text TEXT NOT NULL`, `prev_epoch INTEGER NOT NULL`, `new_contract_text TEXT NOT NULL`, `new_epoch INTEGER NOT NULL`.
- `topology_overlay_ancestors`: `target_run_id TEXT NOT NULL`, `ancestor_run_id TEXT NOT NULL`, `PRIMARY KEY (target_run_id, ancestor_run_id)`.
- `lessons`: `id TEXT PRIMARY KEY`, `partition TEXT`, `directive TEXT NOT NULL`, `epoch_at_creation INTEGER NOT NULL`, `created_by_run_id TEXT`, `recent_outcomes_json TEXT NOT NULL`, `total_clean_passes INTEGER NOT NULL DEFAULT 0`, `total_violated INTEGER NOT NULL DEFAULT 0`, `signal_last_emitted_at_json TEXT NOT NULL DEFAULT '{}'`, `retired INTEGER NOT NULL DEFAULT 0`.

### 3.3 `packages/sqlite/src/merge3.ts`

Exports `threeWayMergeText(baseText: string, oursText: string, theirsText: string): { readonly mergedText: string; readonly hadConflictFallback: boolean }`:
- Performs line-based 3-way merge of `oursText` and `theirsText` against `baseText`.
- If `oursText === baseText`, returns `theirsText`; if `theirsText === baseText` or `oursText === theirsText`, returns `oursText`.
- If non-overlapping hunks changed in `oursText` and `theirsText`, merges both cleanly.
- If genuinely concurrent independent runs modified overlapping lines, falls back to deterministic section concatenation (`SPEC.md` §3.3 line 955) so `commitRunOverlay` never throws or leaves conflict markers in contract text.

---

## 4. Critical Implementation Invariants

1. **Host-Root Path Resolution (`SPEC.md` §1.2 Invariant 5):** `sqlite.ledger`, `sqlite.topologyStore`, `sqlite.lessonStore`, and `sqlite.globalRules` resolve relative file URIs (such as `'.harness/state.sqlite'`) against an immutable `hostRootDir` pinned at store construction time (`path.resolve(opts?.hostRootDir ?? process.cwd(), uri)`), never against `process.cwd()` inside a worktree.
2. **`getInterruptedStepsOnBoot` Coverage (`SPEC.md` §2.6 lines 716–728):**
   - Returns all non-terminal runs (`status IN ('RUNNING', 'WAITING', 'SUSPENDED')`).
   - For runs mid-step, returns the active step's `stepExecId`, `stepId`, `baseScopeCheckpoint`, `headScopeCheckpoint`, and `continuationStack`.
   - For runs that crashed between steps (before Step 0 `recordStepStart`, between Step $i$ `COMPLETED` and Step $i+1$ `recordStepStart`, or during `.replaceWith()` `abortHook`), returns `stepExecId: null`, `stepId: currentStepId`, and `continuationStack: []`.
3. **`markFrameTombstone` Immutability (`SPEC.md` §2.5, §3.4.2):**
   - `markFrameTombstone(runId, messageId, callId, compactedTombstone)` updates `compacted_tombstones_json` (`compactedTombstones[callId] = compactedTombstone`) on `messageId` while keeping `raw_wire_frame` 100% untouched.
4. **CoW Topology Overlay & 3-Way Stacked-PR Commit (`SPEC.md` §2.6 lines 740–778, §3.3 line 955):**
   - `getPartitions(runId)`: when `runId` first loads a partition not yet in `topology_run_overlays`, pins `base_contract_text_at_acquire = base.contract_text` from `topology_base_partitions`.
   - `updateContract(runId, partitionId, newContractText, stepExecId)`: writes to `topology_run_overlays` without re-reading `topology_base_partitions`, increments `current_epoch`, and appends an entry to `topology_overlay_step_mutations` tagged with `stepExecId`.
   - `syncRunOverlays(targetRunId, prerequisiteRunIds)`: copies `ACTIVE` or `SEALED_UNMERGED` overlay entries from `prerequisiteRunIds` into `targetRunId`, advances `targetRunId`'s `base_contract_text_at_acquire` and `synced_contract_text` for each absorbed partition to the prerequisite's `current_contract_text`, and records `prerequisiteRunIds` (plus their transitive `topology_overlay_ancestors`) in `topology_overlay_ancestors` for `targetRunId`.
   - `resetRunOverlay(runId, { scope, stepExecId })`: when `scope === 'step'`, reverts only `topology_overlay_step_mutations` matching `(runId, stepExecId)`, restoring `current_contract_text` and `current_epoch` to the state after the latest earlier `COMPLETED` step (or `synced_contract_text` if none); when `scope === 'run'`, deletes all `topology_overlay_step_mutations` for `runId` and resets `current_contract_text = synced_contract_text` and `current_epoch = synced_epoch`.
   - `commitRunOverlay(runId)`: inside a single SQLite `IMMEDIATE` transaction, collects `committedRunIds = [...ancestors, runId]` (never including dependent child overlays that merely synced *from* `runId` unless folded into `runId` via `syncRunOverlays(runId, [childRunId])`), allocates `newBaseEpoch = currentBase.epoch + 1` monotonically per modified partition, 3-way merges `contractText` against `base_contract_text_at_acquire`, deletes the committed overlays, and returns `{ committedRunIds, updatedEpochs }`.
5. **Compaction Deadlines & Stacked-PR Safety (`SPEC.md` §2.6 line 729, §3.10 line 1359):**
   - `compactRunFrames(runId)` zeroes out `raw_wire_frame` (`Uint8Array(0)`) and sets `is_pruned = 1` on `harness_messages` for `run_id = runId` **only** if `runId` is in a terminal state (`status NOT IN ('RUNNING', 'WAITING', 'SUSPENDED', 'QUEUED')`), never pruning frames of any other `runId` (even one sharing the same `itemKey`) and retaining `harness_runs` receipts and `harness_steps` telemetry.
6. **Offline-Safe SQLite Driver Fallback & Zero-Dependency `PgPoolLike` Engine:**
   - `@harness-dsl/sqlite` loads `better-sqlite3` when its native binary is present and falls back transparently to Node 22+'s built-in `node:sqlite` (`DatabaseSync`) with identical WAL pragma and synchronous transaction semantics if the native addon is unavailable.
   - `@harness-dsl/postgres` accepts an injected `PgPoolLike` (`query(sql, params)`) for external PostgreSQL connections and provides a built-in deterministic in-memory transactional engine when `opts?.pool` is omitted so all `@harness-dsl/postgres` contract tests execute with zero external npm driver dependencies.

---

## 5. Required Test Suite (`packages/sqlite/test/*.test.ts` & `packages/postgres/test/*.test.ts`)

1. **`ledger-store.test.ts`:**
   - `createOrResumeRun` persistence of `compiledPrefixesJson`, `costUsd`, `approvedMaxCostUsd`, `rewindPendingToStepId`, and `completedStepOutputsJson` across multiple completed steps and outer `branchStepId`s.
   - `appendMessageFrame`, `replaceMessageFrame`, `markFrameTombstone` (verifying `rawWireFrame` bytes stay identical while `compactedTombstones[callId]` updates), and `getMessageChain` root-to-leaf reconstruction.
   - `recordForkSuspension`, `getSuspendedForks` with `forkIds` and `parentStepExecId` filtering, and `resolveSuspendedFork` (`RESUMED` vs `ABORTED`).
   - `getInterruptedStepsOnBoot` returning mid-step runs (`baseScopeCheckpoint`, `headScopeCheckpoint`, `continuationStack`) and between-step runs (`stepExecId: null`).
   - `compactRunFrames(runId)` and persisted deadline survival across store re-instantiation, verifying a new active run for the same `itemKey` is never pruned and run receipts/telemetry remain intact.
2. **`topology-store.test.ts`:**
   - Run isolation: `updateContract(runA, 'db', ...)` is invisible to `getPartitions(runB)` and `getPartitions()`.
   - `baseContractTextAtAcquire` pinning: base store updates after `runA` starts do not alter `runA`'s 3-way merge base.
   - Step-scoped vs run-scoped rollback: `resetRunOverlay(runA, { scope: 'step', stepExecId: 'step-2' })` preserves `'step-1'` contract updates, while `resetRunOverlay(runA, { scope: 'run' })` reverts back to the synced prerequisite/run-start base.
   - Stacked PR linear chain ($T_1 \to T_2$) and 3-way merge: `sealRunOverlay(T_1)`, `syncRunOverlays(T_2, [T_1])` advancing $T_2$'s merge base to $C_1$, sequential `commitRunOverlay(T_1)` then `commitRunOverlay(T_2)` merging $C_0 \to C_1 \to C_2$ with zero false conflicts, and verifying `commitRunOverlay(T_1)` does NOT prematurely commit unmerged child $T_2$'s overlay, whereas folding a stacked PR into $T_1$ via `syncRunOverlays(T_1, [T_2])` commits both when $T_1$ merges to `main`.
3. **`lesson-rule-store.test.ts` & `postgres-stores.test.ts`:**
   - `LessonStore`: `admit`, `queryCandidates` BM25 relevance score $R(L, Q) \in [0, 1]$ and partition filtering, `recordOutcomes` sliding window and counters, `syncCreationEpochsForRuns`, `markSignalEmitted`, and `retire`.
   - `sqlite.globalRules` loading validated `GlobalRule[]` and deterministic SHA-256 `digest`.
   - `postgres.*` adapter contract parity tests against both an injected `PgPoolLike` double and the built-in in-memory transactional engine.

---

## 6. Verification Gate Commands

```bash
pnpm check:comments
pnpm --filter @harness-dsl/sqlite typecheck
pnpm --filter @harness-dsl/sqlite test
pnpm --filter @harness-dsl/postgres typecheck
pnpm --filter @harness-dsl/postgres test
```
