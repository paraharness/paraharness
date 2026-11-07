# Milestone M3a — `@harness-dsl/sqlite` & `@harness-dsl/postgres` Storage Adapters

## 1. Scope & Ownership (`owned_dirs` & `forbidden_dirs`)

- **Milestone**: `M3a` (Wave 2 — Parallel Adapter Fan-Out `c`, depends on `M1`)
- **Packages**: `@harness-dsl/sqlite` (`packages/sqlite`) and `@harness-dsl/postgres` (`packages/postgres`)
- **`owned_dirs`**:
  - `packages/sqlite/src/**`
  - `packages/sqlite/test/**`
  - `packages/postgres/src/**`
  - `packages/postgres/test/**`
- **`forbidden_dirs`**:
  - `packages/core/**`
  - `packages/{fs,markdown,node,git,claude,openai,gemini,github,slack,stripe,netsuite,integration}/**`
  - Root workspace configs (`package.json`, `eslint.config.mjs`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`) and `docs/**`
- **Cross-Adapter Independence Rule**:
  - `@harness-dsl/sqlite` and `@harness-dsl/postgres` must have **zero runtime or type imports** from each other or from any other M3 adapter package. `@harness-dsl/sqlite` depends exclusively on `@harness-dsl/core` (`workspace:*`), `better-sqlite3`, `@dagrejs/graphlib`, `node-diff3`, `minisearch`, `p-queue`, and `zod`; `@harness-dsl/postgres` depends exclusively on `@harness-dsl/core` (`workspace:*`), `pg`, `@electric-sql/pglite`, `@dagrejs/graphlib`, `node-diff3`, `minisearch`, `p-queue`, and `zod`, operating against its exported `PostgresQueryClient` / `PostgresPoolFactory` driver contracts (`packages/postgres/src/ddl/postgres-query-client.ts` and `packages/postgres/src/ddl/postgres-pool-factory.ts`) with default `pg.Pool` binding in production and real `@electric-sql/pglite` in `packages/postgres/test/fixtures/pglite-pool-factory.ts`.

### Approved External Libraries & Native Primitives (`CLAUDE.MD` #2 & `docs/CODING_GUIDELINES.md` Rule 3.5)

| Concern | Selected Package / Built-in | Version & License | Evaluated Alternatives & Rejection Reason | Lifecycle & Native/WASM Trade-offs | Owner Approval Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Embedded synchronous SQLite engine (`@harness-dsl/sqlite`) | `better-sqlite3` (`+ @types/better-sqlite3`) | `^12.8.0` (npm `13.0.3`; `^12.8.0` workspace-pinned for prebuilt native addon compatibility, `MIT`, `0` deprecated, `0` CVEs) | `node:sqlite` (experimental synchronous API without mature transaction/WAL ergonomics), `sql.js` (WASM memory-copy overhead on large BLOB wire frames) | Native C++ addon with WAL mode (`PRAGMA journal_mode = WAL`), `IMMEDIATE` transactions, and deterministic `.close()` cleanup in `try / finally` and test `afterEach` | Approved (`Rule 3.5`) |
| Production PostgreSQL connection pool & client (`@harness-dsl/postgres`) | `pg` (`Pool`, `PoolClient`, `+ @types/pg`) | `^8.23.1` (npm `8.23.1`, `MIT`, `0` deprecated, `0` CVEs) | `postgres` (`postgres.js` lacks standard `PoolClient.query` interface parity), fake SQLite-backed regex SQL translator (forbidden by Defect Gate `(e)`) | Forward optional `connect()` on lazy async `PostgresQueryClient` wrappers so `runInPostgresTransaction` pins a single `PoolClient` for `BEGIN`/`COMMIT`/`ROLLBACK` (`docs/lessons/BUILDER.md`); release client in `try / finally` | Approved (`Rule 3.5`) |
| Real local PostgreSQL engine for deterministic tests (`@harness-dsl/postgres`) | `@electric-sql/pglite` (`PGlite`) | `^0.5.15` (npm `0.5.15`, `Apache-2.0`, `0` deprecated, `0` CVEs) | `pg-mem` (incomplete PostgreSQL DDL/JSONB/CTE support), fake cross-engine SQLite translator (forbidden by Defect Gate `(e)`) | WASM PostgreSQL engine; instantiate one shared `PGlite` instance per test suite (`beforeAll`), isolate tests via `TRUNCATE` in `beforeEach`, and call `await pglite.close()` in `afterAll` | Approved (`Rule 3.5`) |
| Prerequisite DAG cycle & depth validation (`mutateLanePlan`) | `@dagrejs/graphlib` (`Graph`, `alg.findCycles`) | `^4.0.7` (npm `4.0.7`, `MIT`, `0` deprecated, `0` CVEs) | Hand-rolled graph cycle traversal (forbidden by Rule 3.5) | Pure JS directed graph validation inside `mutateLanePlan` transaction before committing edges | Approved (`Rule 3.5`) |
| 3-way contract text merge (`TopologyStore.commitRunOverlay`) | `node-diff3` (`diff3Merge`) | `^3.2.1` (npm `3.2.1`, `MIT`, `0` deprecated, `0` CVEs) | Hand-rolled line-by-line 3-way merge algorithm (forbidden by Rule 3.5) | Pure JS 3-way merge of `overlay.contractText` and `currentBase.contractText` against `baseContractTextAtAcquire` | Approved (`Rule 3.5`) |
| BM25 / token-similarity lesson recall (`LessonStore.queryCandidates`) | `minisearch` (`MiniSearch`) | `^7.2.0` (npm `7.2.0`, `MIT`, `0` deprecated, `0` CVEs) | Hand-rolled token/trigram BM25 scorer (forbidden by Rule 3.5) | Pure JS in-memory BM25 index normalized to $R(L, Q) \in [0, 1]$ | Approved (`Rule 3.5`) |
| Async store operation serialization (`PostgresLedgerStore`, `PostgresTopologyStore`, `PostgresLessonStore`) | `p-queue` (`new PQueue({ concurrency: 1 })`) | `^9.1.0` (npm `10.0.0`; `^9.1.0` workspace-pinned, `MIT`, `0` deprecated, `0` CVEs) | Hand-rolled promise mutex (forbidden by Rule 3.5) | Serializes concurrent store mutations with queued-wait-only `AbortSignal` handling (`docs/lessons/BUILDER.md`) | Approved (`Rule 3.5`) |
| Global rule row validation (`sqlite:global-rules`, `postgres:global-rules`) | `zod` (`z.array(GlobalRuleSchema)`) | `^4.6.7` (npm `4.6.7`, `MIT`, `0` deprecated, `0` CVEs) | Manual property checks (forbidden by Rule 3.5) | Pure TypeScript runtime schema validation | Approved (`Rule 3.5`) |

---

## 2. Normative Specification & Coding Sample Grounding

| Normative Source | Section & Exact Line Range | Grounded Scope in `M3a` |
| :--- | :--- | :--- |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §1.1–§1.2 (`lines 3–34`) | Pure passive AST nodes (`SqliteLedgerNode`, `PostgresLedgerNode`, `SqliteTopologyNode`, `PostgresTopologyNode`, `SqliteLessonsNode`, `PostgresLessonsNode`, `SqliteRulesSourceNode`, `PostgresRulesSourceNode`), zero I/O at builder time, and late-bound `EnvRef` resolution via `ctx.resolveEnv`. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §2.1 (`lines 172–189`, `325–337`) | `CompactionConfigNode` (`onSignal`, `onTerminalExit`, `retainFailedRunsForDays`) and `TopologyNode.commitOverlayWhen`. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §2.2 (`lines 807–840`, `1001–1037`, `1068–1092`) | `BaseSourceASTNode`, `BaseLedgerStoreASTNode`, `BaseTopologyStoreASTNode`, `BaseLessonStoreASTNode`, `SourceASTNode`, `LedgerStoreASTNode`, `TopologyStoreASTNode`, `LessonStoreASTNode`. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §2.3–§2.4 (`lines 1094–1358`) | `NodeExecutor`, `RuntimeDriverContext`, `ResolutionContext`, `RuntimeExecutorRegistry`, `RuntimeExecutorRegistrySlice`. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §2.6–§2.7 (`lines 1510–2086`) | `CanonicalMessage`, `WireFrameRecord`, `CompiledWirePrefix`, `UniversalStepTelemetry`, `PendingToolBatch`, `AgentPauseState`, `ContinuationFrame`, `SuspendedForkRecord`, `LedgerStore` (`lines 1882–1989`), `TopologyPartitionState`, `TopologyStore` (`lines 1991–2037`), `LessonOutcome`, `DistilledLessonCandidate`, `LessonRecord`, `LessonStore` (`lines 2039–2086`). |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §3.3 (`lines 2194–2205`) | Relational Topology CoW overlay lifecycle (`getPartitions`, `updateContract` with `stepExecId` and at-most-once per-`(runId, partitionId)` epoch increment, `syncRunOverlays`, `resetRunOverlay` for `scope: 'step' \| 'run'`, `sealRunOverlay`, `commitRunOverlay` 3-way merge against `baseContractTextAtAcquire`, `discardRunOverlay`). |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §3.4.1 & §3.4.3 (`lines 2208–2285`) | `GlobalRuleSchema` validation for `sqlite:global-rules` / `postgres:global-rules`, and `LessonStore` relevance scoring $R(L, Q)$ in `queryCandidates`, `admit`, `recordOutcomes`, `syncCreationEpochsForRuns`, `markSignalEmitted`, and `retire`. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §3.7.2 (`lines 2460–2532`) | `LedgerStore.mutateLanePlan` (linear prerequisite stacking $T_{\text{prevTip}} \leftarrow T_1 \leftarrow \dots \leftarrow T_k \leftarrow T_{\text{parent}}$, `maxPrerequisiteDepth`, cycle detection), `SuspendedForkRecord` monotonic `${forkId}#${suspensionEpoch}`, and `resolveSuspendedFork` recursive epoch resolution. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §3.9–§3.10 (`lines 2549–2616`) | `getInterruptedStepsOnBoot` reboot recovery and `compactRunFrames` raw wire frame pruning. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §4.5 (`lines 3084–3179`) | `SqliteLedgerNode`, `PostgresLedgerNode`, `SqliteTopologyNode`, `PostgresTopologyNode`, `SqliteLessonsNode`, `PostgresLessonsNode`, `SqliteRulesSourceNode`, `PostgresRulesSourceNode`, and `sqlite.*` / `postgres.*` builder contracts (`line 3176`). |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §5 (`line 3197`) | `import { postgres } from '@harness-dsl/postgres'`. |
| [`docs/CODING_SAMPLE.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_SAMPLE.md) | §2 (`line 55`) & §6 (`lines 187, 344–355, 457–475, 554`) | `sqlite.ledger('.harness/state.sqlite').compactWhen(...)`, `sqlite.topologyStore('.harness/state.sqlite')`, and `sqlite.globalRules('.harness/state.sqlite', { table: 'owner_global_rules' })`. |

---

## 3. Planned Module Decomposition & Public Exports

Every file in `packages/sqlite/src/**`, `packages/postgres/src/**`, and `test/fixtures/**` adheres to [`docs/CODING_GUIDELINES.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_GUIDELINES.md) §1–§5 (`<= 250` lines per file, single-kind entity files per Rule 1.1, 1 root `interface` per file plus reachable `TSPropertySignature` / `TSMethodSignature` sub-interfaces per Rule 1.2, 1 `class` per file with optional co-located dedicated 1:1 `*Params`/`*Options` interfaces per Rule 1.3, 1 builder factory function per `create-*-builder.ts` file with optional co-located dedicated 1:1 `*Params`/`*Options` interfaces per Rules 1.6 & 3.3, `internal/` helpers, pure `src/index.ts` barrels, complete `/** ... */` JSDoc per Rules 2.1–2.3, and zero inline/non-JSDoc comments per Rule 2.4).

### 3.1 `packages/sqlite` (`@harness-dsl/sqlite`)

| File Path | Primary Category | Exported Symbols |
| :--- | :--- | :--- |
| `src/builders/compaction-config-builder.ts` | `interface` | `CompactionConfigBuilder` (plus `TSMethodSignature` sub-interfaces `CompactionSignalTriggerOptions`, `CompactionTerminalExitOptions`) |
| `src/builders/create-compaction-config-builder.ts` | `function` | `createCompactionConfigBuilder` |
| `src/builders/sqlite-ledger-builder.ts` | `interface` | `SqliteLedgerBuilder` |
| `src/builders/create-sqlite-ledger-builder.ts` | `function` | `createSqliteLedgerBuilder` |
| `src/builders/sqlite-topology-builder.ts` | `interface` | `SqliteTopologyBuilder` |
| `src/builders/create-sqlite-topology-builder.ts` | `function` | `createSqliteTopologyBuilder` |
| `src/builders/sqlite-lessons-builder.ts` | `interface` | `SqliteLessonsBuilder` |
| `src/builders/create-sqlite-lessons-builder.ts` | `function` | `createSqliteLessonsBuilder` |
| `src/builders/sqlite-global-rules-builder.ts` | `interface` | `SqliteGlobalRulesBuilder` |
| `src/builders/create-sqlite-global-rules-builder.ts` | `function` | `createSqliteGlobalRulesBuilder` |
| `src/builders/sqlite-namespace-contract.ts` | `interface` | `SqliteNamespace` (plus `TSMethodSignature` sub-interface `SqliteGlobalRulesOptions`) |
| `src/builders/sqlite-namespace.ts` | `const` | `sqlite: SqliteNamespace` |
| `src/ddl/sqlite-schema.constants.ts` | `const` | `SQLITE_PRAGMA_STATEMENTS`, `SQLITE_DDL_STATEMENTS` |
| `src/ddl/internal/open-sqlite-connection.ts` | `function` | `openSqliteConnection`, `assertValidSqlIdentifier` |
| `src/stores/sqlite-ledger-store.ts` | `class` | `SqliteLedgerStore` (implementing `LedgerStore`) |
| `src/stores/internal/sqlite-ledger-run-ops.ts` | `function` | `createOrResumeRunInSqlite`, `updateRunInputInSqlite`, `recordRunTerminalReceiptInSqlite`, `getRunTerminalReceiptsFromSqlite` |
| `src/stores/internal/sqlite-ledger-step-ops.ts` | `function` | `recordStepStartInSqlite`, `updateContinuationStackInSqlite`, `recordStepTransitionInSqlite`, `getInterruptedStepsOnBootFromSqlite` |
| `src/stores/internal/sqlite-ledger-plan-and-fork-ops.ts` | `function` | `mutateLanePlanInSqlite`, `recordForkSuspensionInSqlite`, `getSuspendedForksFromSqlite`, `resolveSuspendedForkInSqlite` |
| `src/stores/internal/sqlite-ledger-frame-ops.ts` | `function` | `appendMessageFrameInSqlite`, `replaceMessageFrameInSqlite`, `markFrameTombstoneInSqlite`, `getMessageChainFromSqlite` |
| `src/stores/internal/sqlite-ledger-compaction-ops.ts` | `function` | `compactRunFramesInSqlite` |
| `src/stores/sqlite-topology-store.ts` | `class` | `SqliteTopologyStore` (implementing `TopologyStore`) |
| `src/stores/internal/sqlite-topology-overlay-ops.ts` | `function` | `getPartitionsWithOverlay`, `updateContractInOverlay`, `syncPrerequisiteOverlays`, `resetOverlayByScope` |
| `src/stores/internal/sqlite-topology-commit-ops.ts` | `function` | `sealOverlayForRun`, `commitOverlayThreeWayMerge`, `discardOverlayForRun` |
| `src/stores/sqlite-lesson-store.ts` | `class` | `SqliteLessonStore` (implementing `LessonStore`) |
| `src/stores/internal/sqlite-lesson-ops.ts` | `function` | `queryLessonCandidatesInSqlite`, `admitLessonInSqlite`, `recordLessonOutcomesInSqlite`, `syncLessonEpochsInSqlite` |
| `src/stores/internal/compute-normalized-relevance.ts` | `function` | `computeNormalizedRelevance` (backed by `minisearch` BM25 scoring) |
| `src/executors/sqlite-rules-source-executor.ts` | `function` | `executeSqliteGlobalRulesSource` |
| `src/executors/create-sqlite-executors.ts` | `function` | `createSqliteExecutors` |
| `src/executors/sqlite-executors.constants.ts` | `const` | `sqliteExecutors: RuntimeExecutorRegistrySlice` |
| `src/index.ts` | `barrel` | Pure explicit re-exports of `sqlite`, `SqliteNamespace`, `sqliteExecutors`, `createSqliteExecutors`, `SqliteLedgerStore`, `SqliteTopologyStore`, `SqliteLessonStore`, `SqliteLedgerBuilder`, `SqliteTopologyBuilder`, `SqliteLessonsBuilder`, `SqliteGlobalRulesBuilder`, `SqliteGlobalRulesOptions`, `CompactionConfigBuilder`, `CompactionSignalTriggerOptions`, `CompactionTerminalExitOptions`, `createCompactionConfigBuilder`, `createSqliteLedgerBuilder`, `createSqliteTopologyBuilder`, `createSqliteLessonsBuilder`, `createSqliteGlobalRulesBuilder`, `SqliteLedgerNode`, `SqliteTopologyNode`, `SqliteLessonsNode`, `SqliteRulesSourceNode` |

### 3.2 `packages/postgres` (`@harness-dsl/postgres`)

| File Path | Primary Category | Exported Symbols |
| :--- | :--- | :--- |
| `src/builders/postgres-ledger-builder.ts` | `interface` | `PostgresLedgerBuilder` |
| `src/builders/create-postgres-ledger-builder.ts` | `function` | `createPostgresLedgerBuilder` |
| `src/builders/postgres-topology-builder.ts` | `interface` | `PostgresTopologyBuilder` |
| `src/builders/create-postgres-topology-builder.ts` | `function` | `createPostgresTopologyBuilder` |
| `src/builders/postgres-lessons-builder.ts` | `interface` | `PostgresLessonsBuilder` |
| `src/builders/create-postgres-lessons-builder.ts` | `function` | `createPostgresLessonsBuilder` |
| `src/builders/postgres-global-rules-builder.ts` | `interface` | `PostgresGlobalRulesBuilder` |
| `src/builders/create-postgres-global-rules-builder.ts` | `function` | `createPostgresGlobalRulesBuilder` |
| `src/builders/postgres-namespace-contract.ts` | `interface` | `PostgresNamespace` (plus `TSMethodSignature` sub-interface `PostgresGlobalRulesOptions`) |
| `src/builders/postgres-namespace.ts` | `const` | `postgres: PostgresNamespace` |
| `src/ddl/postgres-query-client.ts` | `interface` | `PostgresQueryClient` (plus `TSMethodSignature` sub-interface `PostgresQueryResult<TRow>`) |
| `src/ddl/postgres-pool-factory.ts` | `interface` | `PostgresPoolFactory` |
| `src/ddl/postgres-schema.constants.ts` | `const` | `POSTGRES_DDL_STATEMENTS` |
| `src/ddl/internal/resolve-postgres-client.ts` | `function` | `resolvePostgresClient`, `assertValidPostgresIdentifier`, `runInPostgresTransaction` (forwarding optional `connect()` on lazy async wrappers per `docs/lessons/BUILDER.md`) |
| `src/stores/postgres-ledger-store.ts` | `class` | `PostgresLedgerStore` (implementing `LedgerStore`) |
| `src/stores/internal/pg-ledger-run-ops.ts` | `function` | `createOrResumeRunInPg`, `updateRunInputInPg`, `recordRunTerminalReceiptInPg`, `getRunTerminalReceiptsFromPg` |
| `src/stores/internal/pg-ledger-step-ops.ts` | `function` | `recordStepStartInPg`, `updateContinuationStackInPg`, `recordStepTransitionInPg`, `getInterruptedStepsOnBootFromPg` |
| `src/stores/internal/pg-ledger-plan-and-fork-ops.ts` | `function` | `mutateLanePlanInPg`, `recordForkSuspensionInPg`, `getSuspendedForksFromPg`, `resolveSuspendedForkInPg` |
| `src/stores/internal/pg-ledger-frame-ops.ts` | `function` | `appendMessageFrameInPg`, `replaceMessageFrameInPg`, `markFrameTombstoneInPg`, `getMessageChainFromPg` |
| `src/stores/internal/pg-ledger-compaction-ops.ts` | `function` | `compactRunFramesInPg` |
| `src/stores/postgres-topology-store.ts` | `class` | `PostgresTopologyStore` (implementing `TopologyStore`) |
| `src/stores/internal/pg-topology-overlay-ops.ts` | `function` | `getPartitionsWithPgOverlay`, `updateContractInPgOverlay`, `syncPrerequisitePgOverlays`, `resetPgOverlayByScope` |
| `src/stores/internal/pg-topology-commit-ops.ts` | `function` | `sealPgOverlayForRun`, `commitPgOverlayThreeWayMerge`, `discardPgOverlayForRun` |
| `src/stores/postgres-lesson-store.ts` | `class` | `PostgresLessonStore` (implementing `LessonStore`) |
| `src/stores/internal/pg-lesson-ops.ts` | `function` | `queryLessonCandidatesInPg`, `admitLessonInPg`, `recordLessonOutcomesInPg`, `syncLessonEpochsInPg` |
| `src/executors/postgres-rules-source-executor.ts` | `function` | `executePostgresGlobalRulesSource` |
| `src/executors/create-postgres-executors.ts` | `function` | `createPostgresExecutors` |
| `src/executors/postgres-executors.constants.ts` | `const` | `postgresExecutors: RuntimeExecutorRegistrySlice` |
| `src/index.ts` | `barrel` | Pure explicit re-exports of `postgres`, `PostgresNamespace`, `postgresExecutors`, `createPostgresExecutors`, `PostgresLedgerStore`, `PostgresTopologyStore`, `PostgresLessonStore`, `PostgresLedgerBuilder`, `PostgresTopologyBuilder`, `PostgresLessonsBuilder`, `PostgresGlobalRulesBuilder`, `PostgresGlobalRulesOptions`, `PostgresQueryResult`, `PostgresQueryClient`, `PostgresPoolFactory`, `createPostgresLedgerBuilder`, `createPostgresTopologyBuilder`, `createPostgresLessonsBuilder`, `createPostgresGlobalRulesBuilder`, `PostgresLedgerNode`, `PostgresTopologyNode`, `PostgresLessonsNode`, `PostgresRulesSourceNode` |

---

## 4. Detailed Implementation Requirements

### 4.0 Single-Kind File Separation, Co-Location & JSDoc Discipline (`docs/CODING_GUIDELINES.md` §§1–3)
1. **Single-Kind Entity Files & Co-Location (`Rules 1.1–1.7 & 3.3`)**:
   - Unrelated or different-kind declarations (`interface`, `function`, `class`, `const`, `type`) must **never** live in the same file in `packages/{sqlite,postgres}/src/**` or `packages/{sqlite,postgres}/test/fixtures/**`.
   - Each root `interface` (`*-builder.ts`, `*-namespace-contract.ts`, `postgres-query-client.ts`, `postgres-pool-factory.ts`) lives in its own single-interface file, co-locating secondary interfaces reachable via `TSPropertySignature` or `TSMethodSignature` parameter/return types (`SqliteGlobalRulesOptions`, `PostgresGlobalRulesOptions`, `CompactionSignalTriggerOptions`, `CompactionTerminalExitOptions`, `PostgresQueryResult<TRow>`) per Rule 1.2.
   - Dedicated 1:1 `*Params` / `*Options` interfaces for a single function or class are co-located in that function or class file (`Rules 1.3, 1.6, 3.3`). Every builder factory function (`create-*-builder.ts`) gets its own single-function file (and at most 4 cohesive functions `<= 40` lines each—or 1 function when `> 40` lines—per `function`-only file per Rule 1.6); every store class gets its own single-class file; every `const` (DDL constants, namespace `const`, executor slice `const`) lives in its own `const`-only file.
2. **JSDoc Anatomy & Approved Library Mandate (`docs/CODING_GUIDELINES.md` §2 & Rule 3.5)**:
   - Use `@dagrejs/graphlib` (`Graph`, `alg.findCycles`) for prerequisite cycle detection, `node-diff3` (`diff3Merge`) for 3-way contract overlay merges in `commitOverlayThreeWayMerge` / `commitPgOverlayThreeWayMerge`, `minisearch` (`MiniSearch`) for BM25 lesson recall in `SqliteLessonStore` / `PostgresLessonStore`, `p-queue` (`concurrency: 1`) for async store serialization, and `pg` (`Pool`) + `@electric-sql/pglite` (`PGlite`) in `@harness-dsl/postgres`.
   - Every `class`, top-level `interface`, public `function` (or `internal/` function `> 20` lines), non-`private` class method (`MethodDefinition`), and interface method (`TSMethodSignature`) in `src/**` and `test/fixtures/**` must carry the 3-part JSDoc anatomy per `docs/CODING_GUIDELINES.md` §2 (2-paragraph Summary + Detailed description separated by an empty `*` line, followed by `@template`, `@param {Type} name - Description`, `@returns {Type} Description`, and `@throws` / `@note` / `@example` where applicable; vertical ASCII column alignment of `@template` and `@param` tags is not required; `private` class methods and small `internal/` helper functions `<= 20` lines require only a 1-paragraph summary + required `@tags`), enforced by `pnpm --filter @harness-dsl/sqlite --filter @harness-dsl/postgres lint`.

### 4.1 Pure AST Builders (`sqlite.*` & `postgres.*`, `SPEC.md` §4.5 & `CODING_SAMPLE.md` §6)
1. **`sqlite.ledger(uri)` & `postgres.ledger(uri)`**:
   - Returns an immutable `AstBuilder<SqliteLedgerNode>` / `AstBuilder<PostgresLedgerNode>` exposing `.compactWhen(($c) => ...)` and `.toAST()`.
   - `.compactWhen` receives a configurator with `.onSignal(signal, { correlateBy, afterGracePeriodHours })`, `.onTerminalExit(states, { afterGracePeriodHours })`, and `.retainFailedRunsForDays(days)` matching `CODING_SAMPLE.md` lines `344–355`.
2. **`sqlite.topologyStore(uri)` / `postgres.topologyStore(uri)`**:
   - Compiles to `SqliteTopologyNode` (`readonly type: 'sqlite:topology'`) / `PostgresTopologyNode` (`readonly type: 'postgres:topology'`).
3. **`sqlite.lessonStore(uri)` / `postgres.lessonStore(uri)`**:
   - Compiles to `SqliteLessonsNode` (`readonly type: 'sqlite:lessons'`) / `PostgresLessonsNode` (`readonly type: 'postgres:lessons'`).
4. **`sqlite.globalRules(uri, { table })` / `postgres.globalRules(uri, { table })`**:
   - Compiles to `SqliteRulesSourceNode` (`readonly type: 'sqlite:global-rules'`) / `PostgresRulesSourceNode` (`readonly type: 'postgres:global-rules'`).
   - Validates `table` against `^[A-Za-z_][A-Za-z0-9_]*$`.

### 4.2 `LedgerStore` Implementation (`SPEC.md` §2.7 lines 1882–1989, §3.7.2, §3.9, §3.10)
1. **Run & Step Lifecycle**:
   - `createOrResumeRun`: inserts a new run row (`status: 'RUNNING'`) or returns the existing run's persisted `status`, `currentStepId`, `inputJson`, `rewindPendingToStepId`, `compiledPrefixesJson` (pinned at initial run start and never overwritten on resume), `costUsd`, `approvedMaxCostUsd`, and `completedStepOutputsJson` (`ReadonlyMap<string, string>` mapping completed `stepId -> outputJson`).
   - `recordStepStart`, `updateContinuationStack` (updating `continuation_stack_json` and optional `baseScopeCheckpoint`), `updateRunInput` (updating `inputJson` and `rewindPendingToStepId`), `recordStepTransition`, `recordRunTerminalReceipt`, `getRunTerminalReceipts`, and `getInterruptedStepsOnBoot` (returning all runs in `'QUEUED' | 'RUNNING' | 'WAITING' | 'SUSPENDED'` along with their latest step's `stepExecId`, `stepId`, `executableId`, `baseScopeCheckpoint`, `headScopeCheckpoint`, and `continuationStack`).
2. **Dynamic DAG Mutation (`mutateLanePlan`)**:
   - Enforces `maxPrerequisiteDepth` and DAG acyclicity across both `spawnedItems` and `addedDependencies` edges (rejecting cycles and prerequisite chains exceeding `maxPrerequisiteDepth` before committing any edge).
   - When `spawnedItems` is provided (`[T_1, ..., T_k]`), chains them linearly onto any previously spawned prerequisite tip $T_{\text{prevTip}}$ of `parentItemKey` ($T_{\text{prevTip}} \leftarrow T_1 \leftarrow \dots \leftarrow T_k \leftarrow T_{\text{parent}}$) inside a single transaction (`SPEC.md` §3.7.2).
3. **Wire Frame & Compaction Operations**:
   - `appendMessageFrame`, `replaceMessageFrame` (updating `rawWireFrame` BLOB and `canonical` JSON for `appendToolResultNotes`), `markFrameTombstone` (setting `compactedTombstones[callId] = compactedTombstone` without mutating `rawWireFrame`), `getMessageChain(leafMessageId)` (walking `parentMessageId` links from `leafMessageId` back to root and returning frames in chronological root-to-leaf order), and `compactRunFrames(runId)` (pruning `rawWireFrame` blobs strictly for `runId` when `runId` is in a terminal state, and never pruning frames belonging to a new active run for the same `itemKey`, while preserving canonical audit headers).
4. **Suspended Fork Records (`recordForkSuspension`, `getSuspendedForks`, `resolveSuspendedFork`)**:
   - Stores `SuspendedForkRecord` keyed by `suspendedForkId` (`${forkId}#${suspensionEpoch}`).
   - `getSuspendedForks(runId, opts)` returns only unresolved records matching optional `forkIds` (by `forkId` or `suspendedForkId`) and `parentStepExecId`.
   - `resolveSuspendedFork(suspendedForkId, status)` marks `${forkId}#${epoch}` and any earlier unresolved epochs `${forkId}#1 .. ${forkId}#${epoch}` for the same `(runId, forkId)` as resolved (`'RESUMED' | 'ABORTED'`).

### 4.3 `TopologyStore` Implementation (`SPEC.md` §2.7 lines 1991–2037 & §3.3)
1. **`getPartitions(runId?)`**:
   - Returns `ReadonlyMap<string, TopologyPartitionState>` merging any active/sealed overlay for `runId` over the canonical base partitions, and pinning `baseContractTextAtAcquire` on first access for `(runId, partitionId)`.
2. **`updateContract(runId, partitionId, newContractText, stepExecId?)`**:
   - Writes to `runId`'s isolated CoW overlay tagged with `stepExecId`, sets `lastMutatedByRunId = runId`, and increments the partition's overlay `epoch` **at most once per `(runId, partitionId)`** (`newEpoch = overlayAlreadyMutatedInRun ? currentOverlayEpoch : currentOverlayEpoch + 1`, unless reset by `resetRunOverlay`).
3. **`syncRunOverlays(targetRunId, prerequisiteRunIds)`**:
   - Merges `ACTIVE` or `SEALED_UNMERGED` overlays from `prerequisiteRunIds` into `targetRunId`'s overlay, preserving `lastMutatedByRunId` and advancing `targetRunId`'s `baseContractTextAtAcquire` for each absorbed partition to the prerequisite's `contractText` so stacked PR commits never false-conflict.
4. **`resetRunOverlay(runId, opts)`**:
   - When `opts?.scope === 'step'`, reverts overlay mutations tagged with `opts.stepExecId` back to the pre-step overlay state (preserving earlier completed steps' overlay mutations); when `scope === 'run'` (or omitted), resets all uncommitted overlay mutations for `runId` back to its synced prerequisite/run-start baseline.
5. **`sealRunOverlay`, `commitRunOverlay`, and `discardRunOverlay`**:
   - `sealRunOverlay(runId)` transitions `runId`'s overlay to `SEALED_UNMERGED`.
   - `commitRunOverlay(runId)` atomically commits `runId`'s overlay (and any absorbed prerequisite `SEALED_UNMERGED` overlays) into the canonical base table, allocating `base.epoch = currentBase.epoch + 1` monotonically, performing a 3-way contract text merge against `baseContractTextAtAcquire`, and returning `{ committedRunIds, updatedEpochs }`.
   - `discardRunOverlay(runId)` deletes `runId`'s overlay without modifying canonical base rows.

### 4.4 `LessonStore` & Global Rules Source Executor (`SPEC.md` §2.7 lines 2039–2086, §3.4, §4.5)
1. **`LessonStore`**:
   - `queryCandidates({ queryText, partitions })`: queries non-retired lessons matching `partition IS NULL OR partition IN (partitions)`, computes normalized token/trigram similarity `relevanceScore` $R(L, Q) \in [0, 1]$, and returns `LessonRecord[]`.
   - `admit`, `recordOutcomes` (appending to `recentOutcomes` and incrementing `totalCleanPasses` on `'clean_pass'` or `totalViolated` on `'violated'`), `syncCreationEpochsForRuns(runIds, updatedEpochs)`, `markSignalEmitted(lessonId, signalId, emittedAt)`, and `retire(lessonIds)`.
2. **`sqlite:global-rules` & `postgres:global-rules` Source Executor**:
   - Queries `SELECT id, directive FROM <table> ORDER BY id ASC`, validates rows with `z.array(GlobalRuleSchema)`, computes SHA-256 `digest`, and returns `{ content: rules, digest }`.

---

## 5. Deterministic Test Suite Architecture (`test/**` & `test/fixtures/**`)

All `test/fixtures/**` files strictly obey single-entity-kind file separation (`<= 250` lines per file, complete §2 JSDoc):

| File Path | Line Ceiling | Required Deterministic Test Cases |
| :--- | :--- | :--- |
| `packages/sqlite/test/fixtures/temp-sqlite-db.ts` | `<= 250` | Function helper creating and cleaning up real temporary SQLite database files in `os.tmpdir()` (with co-located dedicated `TempSqliteDbHandle` interface per Rule 1.6). |
| `packages/sqlite/test/sqlite-builders-and-rules.test.ts` | `<= 400` | Verifies `sqlite.ledger(uri).compactWhen(...)`, `sqlite.topologyStore(uri)`, `sqlite.lessonStore(uri)`, `sqlite.globalRules(uri, { table })`, `.toAST()` immutability, SQL identifier validation, and `sqlite:global-rules` source execution with `GlobalRuleSchema` validation and SHA-256 digest computation. |
| `packages/sqlite/test/sqlite-ledger-store.test.ts` | `<= 400` | Verifies `SqliteLedgerStore`: `createOrResumeRun` (pinning `compiledPrefixesJson`), `recordStepStart`, `updateContinuationStack`, `mutateLanePlan` (linear stacking chain $T_{\text{prevTip}} \leftarrow T_1 \leftarrow T_2 \leftarrow T_{\text{parent}}$, `addedDependencies` DAG acyclicity via `@dagrejs/graphlib` and `maxPrerequisiteDepth` validation, depth limit, cycle rejection), `appendMessageFrame`, `replaceMessageFrame`, `markFrameTombstone`, `getMessageChain`, `SuspendedForkRecord` epoch tracking & recursive `resolveSuspendedFork`, `getInterruptedStepsOnBoot`, and `compactRunFrames` (including verifying `compactRunFrames(runId)` never prunes frames of a new active run for the same `itemKey`). |
| `packages/sqlite/test/sqlite-topology-and-lessons.test.ts` | `<= 400` | Verifies `SqliteTopologyStore` (CoW overlay isolation, at-most-once per-run epoch increment, `syncRunOverlays` stacked-PR baseline advancement, `resetRunOverlay` for `scope: 'step'` vs `'run'`, `sealRunOverlay`, `commitRunOverlay` 3-way merge via `node-diff3` returning `{ committedRunIds, updatedEpochs }`, `discardRunOverlay`) and `SqliteLessonStore` (`admit`, `queryCandidates` with `minisearch` BM25 `relevanceScore`, `recordOutcomes`, `syncCreationEpochsForRuns`, `markSignalEmitted`, `retire`). |
| `packages/postgres/test/fixtures/pglite-pool-factory.ts` | `<= 250` | Single `class` (`PglitePoolFactory`) backed by `@electric-sql/pglite` (`PGlite`) implementing `PostgresQueryClient` / `PostgresPoolFactory` for deterministic local PostgreSQL testing (sharing 1 `PGlite` instance per suite, isolating tests via `TRUNCATE`, forwarding `connect()` for transactional client pinning, and closing `PGlite` in `afterAll`). |
| `packages/postgres/test/postgres-builders-and-stores.test.ts` | `<= 400` | Verifies `postgres.*` builders (including `H.env('DATABASE_URL')` late-bound resolution), `PostgresLedgerStore` (including `addedDependencies` cycle/depth validation via `@dagrejs/graphlib` and `compactRunFrames` run isolation), `PostgresTopologyStore` (3-way merge via `node-diff3`), `PostgresLessonStore` (BM25 recall via `minisearch`), and `postgres:global-rules` source executor against real `PGlite`. |

---

## 6. Verification Gate Commands

Run from workspace root (plus the `IMPL_LOOP.md` `baseline_dirty` diff check against `<non_sibling_forbidden_dirs_excluding_upstream_patches>`):

```bash
pnpm --filter @harness-dsl/sqlite --filter @harness-dsl/postgres lint
pnpm --filter @harness-dsl/sqlite --filter @harness-dsl/postgres typecheck
pnpm --filter @harness-dsl/sqlite --filter @harness-dsl/postgres test -- --reporter=verbose
test -z "$(git status --porcelain -- docs .agents .claude package.json tsconfig.base.json vitest.config.ts)"
```
