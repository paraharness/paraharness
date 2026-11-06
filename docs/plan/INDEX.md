# MetaHarness (`@harness-dsl/*`) — Master Implementation Plan Index

This directory contains the self-contained milestone plans for building and verifying the MetaHarness TypeScript monorepo (`@harness-dsl/*`) against [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) (`lines 1–3324`), [`docs/CODING_SAMPLE.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_SAMPLE.md) (`lines 1–1208`), [`CLAUDE.MD`](file:///Users/torniketsomaia/projects/metaharness/CLAUDE.MD), and [`docs/CODING_GUIDELINES.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_GUIDELINES.md) (§§1–6).

Each milestone file is designed to be handed directly to an isolated **Builder Subagent** (and verified by **Reviewer** and **Verifier** subagents) with bounded context reads: a subagent only needs its mandatory Turn-1 bootstrap manifest (`CLAUDE.MD`, `docs/rules/{GENERAL,BUILDER}.md`, `docs/lessons/{GENERAL,BUILDER}.md`, `docs/CODING_GUIDELINES.md`), its single assigned `docs/plan/M*.md` file, and the exact `docs/SPEC.md` / `docs/CODING_SAMPLE.md` line ranges cited in §2 of that milestone file.

---

## 1. Package Topology & Dependency Graph

Every adapter package (`@harness-dsl/sqlite`, `@harness-dsl/postgres`, `@harness-dsl/fs`, `@harness-dsl/markdown`, `@harness-dsl/node`, `@harness-dsl/git`, `@harness-dsl/claude`, `@harness-dsl/openai`, `@harness-dsl/gemini`, `@harness-dsl/github`, `@harness-dsl/slack`, `@harness-dsl/stripe`, `@harness-dsl/netsuite`) depends **exclusively** on `@harness-dsl/core` (`workspace:*`). Cross-adapter imports are strictly forbidden (`docs/SPEC.md` §1.1, `docs/CODING_SAMPLE.md` §2).

```mermaid
flowchart TD
    M1["M1: @harness-dsl/core<br/>(Pure AST, Ports, Schemas, Topology & H.* Builders)"]
    M2["M2: @harness-dsl/core/runtime<br/>(Universal NodeExecutor Engine & State Machine)"]
    M3a["M3a: @harness-dsl/sqlite<br/>& @harness-dsl/postgres"]
    M3b["M3b: @harness-dsl/fs<br/>& @harness-dsl/markdown"]
    M3c["M3c: @harness-dsl/node"]
    M3d["M3d: @harness-dsl/git"]
    M3e["M3e: @harness-dsl/claude,<br/>@harness-dsl/openai & @harness-dsl/gemini"]
    M3f["M3f: @harness-dsl/github, @harness-dsl/slack,<br/>@harness-dsl/stripe & @harness-dsl/netsuite"]
    M4["M4: @harness-dsl/integration<br/>(engineering-harness, reconciliation-harness & E2E Tests)"]

    M1 --> M2
    M1 --> M3a
    M1 --> M3b
    M1 --> M3c
    M1 --> M3d
    M1 --> M3e
    M1 --> M3f

    M2 --> M4
    M3a --> M4
    M3b --> M4
    M3c --> M4
    M3d --> M4
    M3e --> M4
    M3f --> M4
```

---

## 2. Milestone Execution Topology: `(b) -> (c) -> (b)`

### Wave 1a — Sequential Core Contracts (`M1`, Topology `b`)
- **[M1-core-contracts.md](./M1-core-contracts.md)**: Bootstraps workspace manifests and builds `@harness-dsl/core` (`packages/core/src/{ast,ports,schemas,topology,builders}/**`, `packages/core/src/index.ts`, and initial `packages/core/src/runtime/index.ts`):
  - Pure passive discriminated-union AST foundation (`ASTNode`, `AstBuilder<TNode>`, `MaybeBuilder<TNode>`, `extractAST`, `EnvRef`, `CoreASTNode`, `DomainASTNode`, `CustomDomainASTRegistry`, and all base/domain AST interfaces from `SPEC.md` §§2.1–2.2 & §§4.1–4.5).
  - Universal `NodeExecutor`, `RuntimeExecutorRegistry`, `createExecutorRegistry`, `IsolationScope` (`'scope'`), `CheckpointableScope` (`'checkpointable'`), `BranchableScope` (`'branchable'`), `ModelDriver`, `LedgerStore`, `TopologyStore`, `LessonStore`, `TrackerAdapter`, `StreamSource`, `HumanAdapter`, and `ControlPlaneAdapter` ports (`SPEC.md` §§2.3–2.8).
  - Schemas (`ScopePredicateSchema`, `GlobalRuleSchema`, `ScopedRuleSchema`, `BudgetApprovalSchema`, `ResumeForkInputSchema`, `SpeculationCandidateSchema`, `SpeculationInputSchema`, `zodToJsonSchema`) and topology DAG queries (`dependentsOf`, `affectedBy`).
  - All fluent `H.*` builders (`H.env`, `H.signal`, `H.interrupt`, `H.stream`, `H.pool`, `H.prefixGroup`, `H.topology`, `H.rules`, `H.scopedRule`, `H.skill`, `H.lessons`, `H.policy`, `H.human`, `H.command`, `H.agent`, `H.loop`, `H.flow`, `H.lane`, `H.harness`) with static build-time validation of `capabilityTier`, `effectTracking`, `interactionMode`, `.withTools()` canonical `roleKey` derivation, and `.withPolicy()` interrupt handler preservation.

### Wave 1b — Sequential Core Runtime Engine (`M2`, Topology `b`)
- **[M2-core-runtime.md](./M2-core-runtime.md)**: Builds `@harness-dsl/core/runtime` (`packages/core/src/runtime/**`, `packages/core/src/runtime/index.ts`, `packages/core/test/runtime-*.test.ts`, and runtime re-exports in `packages/core/src/index.ts`) once M1 passes its gate:
  - `ScopeLockManager` (shared-read vs exclusive-write handle locks), `StepContinuationQueue` (per-`stepExecId` FIFO serialization), `PoolManager` (run-sticky seat affinity, `429` failover, `escalate-on-retry`), and `ServiceSessionRegistry` (reference-counted daemons across `activeSkillIds`, step-boundary quiescing, pre-drain re-acquisition with `[SERVICE_REACQUIRED]`).
  - Run-immutable `CompiledWirePrefix` compilation, in-run `updatedGroundingDiffs`, Turn-0 `[ROLE_AND_SCOPE_CONTEXT]` frames, and `H.lessons` scoring/distillation/retirement.
  - Two-phase policy guard evaluation (`'deny-with-error'` before `'raise-interrupt'`, multi-call pre-flight batching, post-flight `effectTracking: 'subprocess-post-flight'` sandboxing with `inFlightPreToolCheckpoint` rollback, declaration-ordered `remainingCalls` replay, nested `.adjudicateWith()` outer lease attachment, and 4-step `.onLimitExceeded()` epistemic flush).
  - `executeAgent`, `executeLoop`, `executeCommand`, `executeStepNode`, `executeFlow`, `LaneScheduler`, and `createRuntime`: downward `.fork()` (with conflict-bounce retry loop), speculative `.speculate()` (Post-Race Cases 1–4, `PARKED_ON_ESCALATION`, `refineWinnerWhen`, non-destructive `unpark-escalation`), dynamic `.mutatePlan()` (linear prerequisite chaining, `suspend-and-yield-slot`, replay-idempotent `syncRoot`), and upward `.onChildInterrupt()` + `resumeFork` (Cases A/B/C and recursive epoch resolution).

### Wave 2 — Parallel Adapter Fan-Out (`M3a`–`M3f`, Topology `c`)
All 6 adapter milestones depend **only** on `@harness-dsl/core` from M1 and touch strictly disjoint `packages/<adapter>/**` directories:
- **[M3a-sqlite.md](./M3a-sqlite.md)**: `@harness-dsl/sqlite` (`packages/sqlite/**`) and `@harness-dsl/postgres` (`packages/postgres/**`).
- **[M3b-fs-markdown.md](./M3b-fs-markdown.md)**: `@harness-dsl/fs` (`packages/fs/**`) and `@harness-dsl/markdown` (`packages/markdown/**`).
- **[M3c-node.md](./M3c-node.md)**: `@harness-dsl/node` (`packages/node/**`).
- **[M3d-git.md](./M3d-git.md)**: `@harness-dsl/git` (`packages/git/**`).
- **[M3e-drivers.md](./M3e-drivers.md)**: `@harness-dsl/claude` (`packages/claude/**`), `@harness-dsl/openai` (`packages/openai/**`), and `@harness-dsl/gemini` (`packages/gemini/**`).
- **[M3f-connectors.md](./M3f-connectors.md)**: `@harness-dsl/github` (`packages/github/**`), `@harness-dsl/slack` (`packages/slack/**`), `@harness-dsl/stripe` (`packages/stripe/**`), and `@harness-dsl/netsuite` (`packages/netsuite/**`).

### Wave 3 — End-to-End Reference Harnesses & Integration Verification (`M4`, Topology `b`)
- **[M4-integration.md](./M4-integration.md)**: Builds `@harness-dsl/integration` (`packages/integration/**`), compiling and testing both the complete `engineering-harness` reference implementation (`CODING_SAMPLE.md` §6) and the non-coding financial `reconciliation-harness` (`SPEC.md` §5) end-to-end across all `@harness-dsl/*` packages.

---

## 3. File & Directory Ownership Matrix

| Milestone | Owned Directories (`owned_dirs` — Read/Write) | Forbidden Directories (`forbidden_dirs` — Zero Touch) |
| :--- | :--- | :--- |
| **M1** | Root workspace manifests (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`), `packages/*/{package.json,tsconfig.json}`, `packages/core/src/{ast,ports,schemas,topology,builders}/**`, `packages/core/src/index.ts`, `packages/core/src/runtime/index.ts`, `packages/core/test/{fixtures,ast-and-schemas.test.ts,topology-and-builders.test.ts,flow-and-validation.test.ts}` | `packages/core/src/runtime/**` (except `runtime/index.ts`), `packages/{sqlite,postgres,fs,markdown,node,git,claude,openai,gemini,github,slack,stripe,netsuite,integration}/{src,test}/**`, `docs/**` |
| **M2** | `packages/core/src/runtime/**`, `packages/core/src/runtime/index.ts`, `packages/core/src/index.ts` (runtime re-exports), `packages/core/test/fixtures/**`, `packages/core/test/runtime-*.test.ts` | `packages/core/src/{ast,ports,schemas,topology,builders}/**`, all adapter packages, `packages/integration/**`, root configs, `docs/**` |
| **M3a** | `packages/sqlite/{src,test}/**`, `packages/postgres/{src,test}/**` | `packages/core/**`, all other `packages/*/**`, root configs, `docs/**` |
| **M3b** | `packages/fs/{src,test}/**`, `packages/markdown/{src,test}/**` | `packages/core/**`, all other `packages/*/**`, root configs, `docs/**` |
| **M3c** | `packages/node/{src,test}/**` | `packages/core/**`, all other `packages/*/**`, root configs, `docs/**` |
| **M3d** | `packages/git/{src,test}/**` | `packages/core/**`, all other `packages/*/**`, root configs, `docs/**` |
| **M3e** | `packages/claude/{src,test}/**`, `packages/openai/{src,test}/**`, `packages/gemini/{src,test}/**` | `packages/core/**`, all other `packages/*/**`, root configs, `docs/**` |
| **M3f** | `packages/github/{src,test}/**`, `packages/slack/{src,test}/**`, `packages/stripe/{src,test}/**`, `packages/netsuite/{src,test}/**` | `packages/core/**`, all other `packages/*/**`, root configs, `docs/**` |
| **M4** | `packages/integration/{src,test}/**` | `packages/core/**`, all adapter `packages/*/**`, root configs, `docs/**` |

---

## 4. Global Invariants for All Subagents

1. **Pure AST & Late Binding (`docs/SPEC.md` §1.1–§1.2, `docs/CODING_GUIDELINES.md` Rule 5.2):**
   - Every builder method and `.toAST()` call must be 100% side-effect-free (zero filesystem, network, subprocess, or database I/O at import or builder time) and return deeply frozen (`Object.freeze`) monomorphic AST objects (`docs/CODING_GUIDELINES.md` Rule 4.3).
2. **Explicit Capabilities & Symbolic `EnvRef` (`docs/SPEC.md` §1.2, `docs/CODING_GUIDELINES.md` Rule 5.2):**
   - Never read `.env` or evaluate `process.env` at module import or builder time. Secrets and environment-dependent values are represented symbolically via `H.env('KEY')` (`EnvRef`) in AST definitions and resolved exclusively at leaf adapter execution time via `ctx.resolveEnv`.
3. **File & Module Taxonomy (`docs/CODING_GUIDELINES.md` §1):**
   - **Cohesive single-concept files:** One shared top-level `interface` per file (with natural nested sub-interfaces), one `class` per file, grouped pure type unions in `*.types.ts`, grouped constants/schemas in `*.constants.ts` / `*.schema.ts`, non-public helpers in `internal/<domain-verb>.ts`, and pure explicit barrels in `index.ts` (zero wildcard `export *` in package root `src/index.ts`).
   - **Universal line ceilings:** Every non-test file (`src/**`, `test/fixtures/**`, `scripts/**`, `.agents/hooks/**`) must be **`<= 250` lines**; every test file (`test/**/*.test.ts`) must be **`<= 400` lines**.
   - **Strict DAG imports & 1:1 naming:** Leaf files import directly from sibling leaf files (never back through `index.js`), and grab-bag file names (`utils.ts`, `helpers.ts`, `common.ts`, `shared.ts`, `misc.ts`, `core.ts`, `base.ts`, unprefixed `types.ts` / `constants.ts` / `schemas.ts`) are forbidden.
4. **Mandatory JSDoc & Zero Inline Comments (`CLAUDE.MD`, `docs/CODING_GUIDELINES.md` §2):**
   - Write structured `/** ... */` JSDoc on every class (and its constructor, methods, and properties), interface (and its properties and methods), function (public and `internal/`), and exported `type` alias or `const` in `src/**` and `test/fixtures/**` per `docs/CODING_GUIDELINES.md` Rules 2.1–2.3.
   - Write **zero inline or non-JSDoc comments** (single-line slash comments, non-JSDoc block comments, hash comments, or HTML comments) in any file, and **zero comments of any kind** inside a function, method, or constructor body (`docs/CODING_GUIDELINES.md` Rule 2.4).
5. **Clean Code, Runtime Performance & Type Rigor (`docs/CODING_GUIDELINES.md` §§3–5):**
   - Keep functions `<= 80` lines (hard ceiling `100` lines) with flat guard clauses (max nesting depth `3`) and named parameter objects whenever a function/method/constructor takes `> 3` parameters.
   - Use single-pass `for` loops (zero array/object spread accumulation in loops, zero `.filter().map().flatMap()` chains in runtime paths) and pre-indexed `Map` / `Set` $O(1)$ lookups; pre-compile `picomatch` globs and `RegExp` instances once at registration.
   - Release all acquired resources (leases, worktrees, daemons, child processes, DB transactions, `AbortSignal` listeners) inside `try / finally`.
   - Zero `: any`, `as any`, `as unknown as T`, unguarded `!` non-null assertions, or `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck` directives in `src/**` or `test/**`.
6. **Real-Resource Deterministic Testing (`docs/CODING_GUIDELINES.md` §6):**
   - Organize tests per subsystem (`<= 400` lines per `test/*.test.ts`), placing shared fakes/fixtures in `test/fixtures/` (`<= 250` lines per file, with full §2 JSDoc).
   - Test against real local SQLite databases, real Git repositories/worktrees, real temporary directories, and real Node child processes/daemons; coordinate concurrency with deterministic barrier latches (zero `setTimeout` sleeps) and assert exact structural outputs and error messages.

---

## 5. Milestone Summary & Scoped Gate Commands

| Milestone | Plan File | Target Packages | Scoped Verification Gate Commands |
| :--- | :--- | :--- | :--- |
| **M1** | [`docs/plan/M1-core-contracts.md`](./M1-core-contracts.md) | `@harness-dsl/core` *(Pure AST, Ports, Schemas, Topology & `H.*` Builders)* | `pnpm --filter @harness-dsl/core typecheck && pnpm --filter @harness-dsl/core test -- --reporter=verbose` |
| **M2** | [`docs/plan/M2-core-runtime.md`](./M2-core-runtime.md) | `@harness-dsl/core` *(Runtime Engine & State Machine)* | `pnpm --filter @harness-dsl/core typecheck && pnpm --filter @harness-dsl/core test -- --reporter=verbose` |
| **M3a** | [`docs/plan/M3a-sqlite.md`](./M3a-sqlite.md) | `@harness-dsl/sqlite`, `@harness-dsl/postgres` | `pnpm --filter @harness-dsl/sqlite --filter @harness-dsl/postgres typecheck && pnpm --filter @harness-dsl/sqlite --filter @harness-dsl/postgres test -- --reporter=verbose` |
| **M3b** | [`docs/plan/M3b-fs-markdown.md`](./M3b-fs-markdown.md) | `@harness-dsl/fs`, `@harness-dsl/markdown` | `pnpm --filter @harness-dsl/fs --filter @harness-dsl/markdown typecheck && pnpm --filter @harness-dsl/fs --filter @harness-dsl/markdown test -- --reporter=verbose` |
| **M3c** | [`docs/plan/M3c-node.md`](./M3c-node.md) | `@harness-dsl/node` | `pnpm --filter @harness-dsl/node typecheck && pnpm --filter @harness-dsl/node test -- --reporter=verbose` |
| **M3d** | [`docs/plan/M3d-git.md`](./M3d-git.md) | `@harness-dsl/git` | `pnpm --filter @harness-dsl/git typecheck && pnpm --filter @harness-dsl/git test -- --reporter=verbose` |
| **M3e** | [`docs/plan/M3e-drivers.md`](./M3e-drivers.md) | `@harness-dsl/claude`, `@harness-dsl/openai`, `@harness-dsl/gemini` | `pnpm --filter @harness-dsl/claude --filter @harness-dsl/openai --filter @harness-dsl/gemini typecheck && pnpm --filter @harness-dsl/claude --filter @harness-dsl/openai --filter @harness-dsl/gemini test -- --reporter=verbose` |
| **M3f** | [`docs/plan/M3f-connectors.md`](./M3f-connectors.md) | `@harness-dsl/github`, `@harness-dsl/slack`, `@harness-dsl/stripe`, `@harness-dsl/netsuite` | `pnpm --filter @harness-dsl/github --filter @harness-dsl/slack --filter @harness-dsl/stripe --filter @harness-dsl/netsuite typecheck && pnpm --filter @harness-dsl/github --filter @harness-dsl/slack --filter @harness-dsl/stripe --filter @harness-dsl/netsuite test -- --reporter=verbose` |
| **M4** | [`docs/plan/M4-integration.md`](./M4-integration.md) | `@harness-dsl/integration` *(Full Workspace E2E)* | `pnpm --filter @harness-dsl/integration typecheck && pnpm --filter @harness-dsl/integration test -- --reporter=verbose && pnpm -r typecheck && pnpm -r test -- --reporter=verbose` |
