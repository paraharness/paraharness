# Milestone M4 — `@harness-dsl/integration` Reference Harnesses (`engineering-harness` & `reconciliation-harness`) & End-to-End Protocol Verification

## 1. Scope & Ownership (`owned_dirs` & `forbidden_dirs`)

- **Milestone**: `M4` (Wave 3 — End-to-End Integration `b`, depends on `M2` and `M3a..M3f`)
- **Package**: `@harness-dsl/integration` (`packages/integration`)
- **`owned_dirs`**:
  - `packages/integration/src/**`
  - `packages/integration/test/**`
- **`forbidden_dirs`**:
  - `packages/core/**`
  - `packages/{sqlite,postgres,fs,markdown,node,git,claude,openai,gemini,github,slack,stripe,netsuite}/**`
  - Root workspace configs (`package.json`, `eslint.config.mjs`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`) and `docs/**`
- **Upstream Escalation Rule (`docs/rules/BUILDER.md` Rule 2)**:
  - If an end-to-end integration test exposes a contract or runtime defect in `@harness-dsl/core` or any `@harness-dsl/*` adapter package, escalate immediately via `BLOCKED_ON_UPSTREAM` citing the exact `file:line` and failing assertion rather than modifying `forbidden_dirs` without Head authorization in `upstream_patches`.

---

## 2. Normative Specification & Coding Sample Grounding

| Normative Source | Section & Exact Line Range | Grounded Scope in `M4` |
| :--- | :--- | :--- |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §1–§4 (`lines 1–3180`) | All declarative AST invariants, runtime execution protocols (§3.1–§3.10), and peer adapter specifications (§4.1–§4.5). |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §5 (`lines 3182–3324`) | Non-Coding Financial Harness (`reconciliationFlow`, `manualEscalationAgent`, `CustomDomainASTRegistry` declaration merging with `@harness-dsl/stripe` and `@harness-dsl/netsuite` over Tier-1 `IsolationScope` `capabilityTier: 'scope'`). |
| [`docs/CODING_SAMPLE.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_SAMPLE.md) | §1–§5 (`lines 1–173`) | Operational Invariants 1–5 (`Role-Scoped Prefix Groups`, `Dynamic Work-Graph Mutation`, `Chained Guard Clauses`, `Two-Temperature Persistence`, `Deduplicated Evidence-Based Lesson Loop`) and Truth-Maintenance Protocols 1–3 (`Existing Test Lease Adjudication`, `Upward Architectural Interrupts`, `Speculative Tournament with Deferred Escalation`). |
| [`docs/CODING_SAMPLE.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_SAMPLE.md) | §6 (`lines 176–1208`) | Complete Production Implementation (`engineering-harness.ts`): `workItem`, `workReceipt`, `evaluationResult`, `steerSignal`, `changeShippedSignal`, `prClosedUnmergedSignal`, `highLeverageLessonSignal`, `scopeTripwire`, `leaseRequest`, `contractViolation`, `normativeEscalation`, `repoTopology`, `repoPartitions`, `workspace`, `repoRules`, `repoLessons`, `dbMigrationSkill`, `uiVerificationSkill`, `engineeringPrefix`, `workerBasePolicy`, `fastPathPolicy`, `coordinatorPolicy`, `worker`, `evaluator`, `leaseAdjudicator`, `candidateArbiter`, `guardedWorker`, `verifiedWorkerLoop`, `coordinator`, `engineeringFlow`, `engineeringLane`, `appHarness`. |

---

## 3. Planned Module Decomposition & Public Exports (`packages/integration/src/**`)

Every file in `packages/integration/src/**` and `packages/integration/test/fixtures/**` adheres to [`docs/CODING_GUIDELINES.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_GUIDELINES.md) §1–§5 (`<= 250` lines per file, zero co-location of `interface` / `function` / `class` / `const` / `type`, strictly 1 top-level `interface` per file, 1 `class` per file, pure `src/index.ts` barrel, full 3-part `/** ... */` JSDoc on every declaration and `TSMethodSignature`, and zero inline/non-JSDoc comments).

| File Path | Primary Category | Exported Symbols |
| :--- | :--- | :--- |
| `src/engineering/engineering-schemas.schema.ts` | `schema` | `partitionEnum`, `workItem`, `WorkItem`, `workReceipt`, `WorkReceipt`, `evaluationResult`, `EvaluationResult`, `forkRequestSchema`, `ForkRequest`, `speculateRequestSchema`, `SpeculateRequest`, `arbiterVerdictSchema`, `ArbiterVerdict`, `ownerDecisionSchema`, `OwnerDecision`, `deliveryInputSchema`, `DeliveryInput` |
| `src/engineering/signals-and-interrupts.constants.ts` | `const` | `steerSignal`, `changeShippedSignal`, `prClosedUnmergedSignal`, `highLeverageLessonSignal`, `scopeTripwire`, `leaseRequest`, `contractViolation`, `normativeEscalation` |
| `src/engineering/pools-and-services.constants.ts` | `const` | `runner`, `claudeAccounts`, `sonnet`, `opus`, `workerModels`, `ledger`, `slackBot`, `owner`, `drizzleGenerate`, `verifySuite`, `localPostgres`, `browserSandbox`, `githubWebhookSource`, `githubMergeStream`, `githubPrClosedStream` |
| `src/engineering/topology-and-workspace.constants.ts` | `const` | `repoTopology`, `repoPartitions`, `workspace` |
| `src/engineering/rules-lessons-and-skills.constants.ts` | `const` | `forbidDrizzleInApiCheck`, `forbidDropColumnCheck`, `repoRules`, `repoLessons`, `dbMigrationSkill`, `uiVerificationSkill`, `sharedProceduralSkills`, `engineeringPrefix` |
| `src/engineering/policies.constants.ts` | `const` | `readOnlyPolicy`, `workerBasePolicy`, `fastPathPolicy`, `coordinatorPolicy` |
| `src/engineering/worker-and-evaluators.constants.ts` | `const` | `crossTester`, `worker`, `evaluator`, `leaseAdjudicator`, `candidateArbiter`, `guardedWorker`, `verifiedWorkerLoop` |
| `src/engineering/coordinator.constants.ts` | `const` | `coordinator` |
| `src/engineering/delivery-and-flow.constants.ts` | `const` | `landChanges`, `checkExistingPr`, `publishPr`, `engineeringFlow` |
| `src/engineering/engineering-lane-and-harness.constants.ts` | `const` | `issuesTracker`, `engineeringLane`, `appHarness` |
| `src/engineering/create-engineering-harness-runtime.ts` | `function` | `createEngineeringHarnessRuntime` |
| `src/financial/financial-domain-registry.ts` | `interface` | `declare module '@harness-dsl/core'` augmenting `CustomDomainASTRegistry` (including `effectMatcher: StripeMaxRefundMatcherNode` alongside `scope`, `guard`, `abortHook`, `tool`, and `check`) |
| `src/financial/reconciliation-schemas.schema.ts` | `schema` | `discrepancyItem`, `DiscrepancyItem`, `settlementReceipt`, `SettlementReceipt` |
| `src/financial/reconciliation-harness.constants.ts` | `const` | `highValueApprovalRequest`, `reconcileLimitExceeded`, `financeController`, `autoReconcilePolicy`, `manualReconcilePolicy`, `reconciliationAgent`, `manualEscalationAgent`, `reconciliationFlow` |
| `src/financial/create-reconciliation-harness-runtime.ts` | `function` | `createReconciliationHarnessRuntime` |
| `src/index.ts` | `barrel` | Pure explicit re-exports of all symbols from `./engineering/engineering-schemas.schema.js`, `./engineering/signals-and-interrupts.constants.js`, `./engineering/pools-and-services.constants.js`, `./engineering/topology-and-workspace.constants.js`, `./engineering/rules-lessons-and-skills.constants.js`, `./engineering/policies.constants.js`, `./engineering/worker-and-evaluators.constants.js`, `./engineering/coordinator.constants.js`, `./engineering/delivery-and-flow.constants.js`, `./engineering/engineering-lane-and-harness.constants.js`, `./engineering/create-engineering-harness-runtime.js`, `./financial/reconciliation-schemas.schema.js`, `./financial/reconciliation-harness.constants.js`, and `./financial/create-reconciliation-harness-runtime.js` |

---

## 4. Detailed Implementation Requirements

### 4.0 Strict File Separation & Full 3-Part JSDoc (`docs/CODING_GUIDELINES.md` §§1–2)
1. **Zero Co-Location of Entity Kinds**:
   - `interface`, `function`, `class`, `const`, and `type` declarations must **never** live in the same file in `packages/integration/src/**` or `packages/integration/test/fixtures/**` (sole exception: `*.schema.ts` pairing Zod schemas with their `z.infer` types).
   - `src/financial/financial-domain-registry.ts` (`interface` augmentation), `src/financial/reconciliation-schemas.schema.ts` (`schema`), `src/financial/reconciliation-harness.constants.ts` (`const`), and `src/financial/create-reconciliation-harness-runtime.ts` (`function`) are strictly separated by entity kind; likewise `src/engineering/engineering-schemas.schema.ts` (`schema`), `src/engineering/*.constants.ts` (`const`), and `src/engineering/create-engineering-harness-runtime.ts` (`function`) never mix entity kinds.
2. **Full 3-Part JSDoc Requirement**:
   - Every `interface`, `class`, `function`, class method, **interface method signature (`TSMethodSignature`)**, `type`, and exported `const` in `src/**` and `test/fixtures/**` must carry full 3-part JSDoc per `docs/CODING_GUIDELINES.md` §2 (2-paragraph Summary + Detailed description separated by a blank `*` line, vertically aligned `@template` and `@param {Type} name - Description`, and `@returns {Type} Description`), enforced by `pnpm --filter @harness-dsl/integration lint`.

### 4.1 Exact Reference Harness Fidelity & Coding Guidelines Compliance (`CODING_SAMPLE.md` §6, `SPEC.md` §5, `CODING_GUIDELINES.md` §§1–5)
1. **Production Engineering Harness (`src/engineering/**`)**:
   - Implements 100% of the declarations, schemas, signals, interrupts, pools, services, topology, partition map, CoW worktree scope, rules, lessons, skills, role-scoped prefix group, policies, agents (`worker`, `evaluator`, `leaseAdjudicator`, `candidateArbiter`, `guardedWorker`, `verifiedWorkerLoop`, `coordinator`), delivery steps (`landChanges`, `checkExistingPr`, `publishPr`), `engineeringFlow`, `engineeringLane`, and `appHarness` from `CODING_SAMPLE.md` §6 (`lines 178–1208`) across the focused single-entity-kind files (`<= 250` lines each with full §2 JSDoc).
   - When translating `CODING_SAMPLE.md` §6 and `SPEC.md` §5 into `src/engineering/**` and `src/financial/**`, **strip all inline `//` comments** (`CODING_GUIDELINES.md` Rule 2.4), **replace `.flatMap()` / `.filter().map()` chains with single-pass `for` loops** (`CODING_GUIDELINES.md` Rule 4.1), and **replace any `as` casts with explicit type guards/predicates** (`CODING_GUIDELINES.md` Rule 5.1).
   - Compiles with **zero** `: any`, `as any`, `as unknown as`, or `@ts-ignore` suppressions.
2. **Non-Coding Financial Harness (`src/financial/**`)**:
   - Implements 100% of `SPEC.md` §5 (`lines 3186–3324`), augmenting `CustomDomainASTRegistry` in `src/financial/financial-domain-registry.ts` (`SPEC.md:3217–3225`) with `scope`, `guard`, `abortHook`, `tool`, `check`, and `effectMatcher: StripeMaxRefundMatcherNode`, and compiling `reconciliationFlow` over Tier-1 `netsuite.draftJournalScope()` (`capabilityTier: 'scope'`).
3. **Combined `RuntimeExecutorRegistry` Wiring (`createEngineeringHarnessRuntime` & `createReconciliationHarnessRuntime`)**:
   - Uses `const registry = createExecutorRegistry(sqliteExecutors, postgresExecutors, fsExecutors, markdownExecutors, nodeExecutors, gitExecutors, claudeExecutors, openaiExecutors, geminiExecutors, githubExecutors, slackExecutors, stripeExecutors, netsuiteExecutors)` and `createRuntime(appHarness, { registry, env })` to verify all AST node discriminants resolve to registered executors at startup.

---

## 5. Deterministic Test Suite Architecture (`packages/integration/test/**`)

All end-to-end tests (`<= 400` lines per file, fixtures `<= 250` lines with single-entity-kind separation and full 3-part §2 JSDoc) run against **real** local SQLite databases, **real** temporary Git repositories and CoW worktrees (`git.cowWorktree`), **real** filesystem tools/guards (`fs.*`), **real** Markdown rule/skill files (`md.*`), and **real** Node subprocesses/daemons (`local.*`), using scripted `ModelDriver` and `HumanAdapter` responses (`docs/CODING_GUIDELINES.md` §6):

| File Path | Line Ceiling | Required Deterministic Test Cases |
| :--- | :--- | :--- |
| `test/fixtures/integration-workspace-handle.ts` | `<= 250` | `IntegrationWorkspaceHandle` (`interface` only, describing the initialized monorepo paths, git remote, and cleanup hook). |
| `test/fixtures/create-integration-workspace-fixture.ts` | `<= 250` | Pure `function` initializing a real temporary monorepo (`packages/{db,api,web}`, `PRODUCT_SPEC.md`, `TECH_DESIGN.md`, `.harness/rules/**`, `.harness/skills/**`, `.harness/prompts/**`, local bare `origin` git remote, and real `.harness/state.sqlite`). |
| `test/fixtures/scripted-integration-model-driver.ts` | `<= 250` | `ScriptedIntegrationModelDriver` (`class` only, implementing `ModelDriver` to orchestrate multi-turn tool calls `edit_file`, `write_file`, `delegate-partition`, `explore-candidates`, `spawnTasks`, and `resumeFork`). |
| `test/fixtures/scripted-integration-human-adapter.ts` | `<= 250` | `ScriptedIntegrationHumanAdapter` (`class` only, implementing `HumanAdapter` to orchestrate deterministic human Slack rulings, notifications, and `cancelDecision` tracking). |
| `test/ast-and-financial-harness-e2e.test.ts` | `<= 400` | 1. Verifies `appHarness.toAST()` and `reconciliationFlow.toAST()` are deeply frozen, JSON-serializable, and perform zero I/O at build time.<br>2. Executes `reconciliationFlow` (`SPEC.md` §5) end-to-end: verifies `netsuite.forbidClosedPeriodPosting()` denies closed-period postings in-band, `stripe.maxRefundGuardUsd(500)` raises `highValueApprovalRequest` to `financeController`, `stripe.allowRefundUpToUsd(10_000)` elevates the lease and drains `remainingCalls`, and turn exhaustion triggers `reconcileLimitExceeded` -> `netsuite.rollbackDraftJournal()` -> `.replaceWith(manualEscalationAgent)`. |
| `test/fast-path-and-lease-adjudication-e2e.test.ts` | `<= 400` | 1. Protocol 1 (`Existing Test Lease Adjudication`, `CODING_SAMPLE.md` §5.1): `guardedWorker` edits implementation code and attempts to edit an existing `.test.ts` file; `fs.writeGuard` (`onlyExistingAtBaseRef: true`) intercepts the edit pre-flight and raises `leaseRequest` to `leaseAdjudicator`; when `leaseAdjudicator` escalates `normativeEscalation` to `owner`, the nested `$esc.elevateLeaseWhen` attaches `fs.allowWriteGlobs` to the outer `guardedWorker` and `verifiedWorkerLoop`, replaying the blocked edit and passing `verifySuite` and `evaluator`.<br>2. Fast-path `scopeTripwire` (`fs.maxFilesMutated(4)` / `.maxTurns(8)`): executes the 4-step `.onLimitExceeded()` flush, snapshots the dirty worktree to `refs/harness/aborted/<run-id>/<stepExecId>` via `git.snapshotAndReset()`, and promotes to `coordinator`, which inspects the aborted ref via `git.refReaderTools`. |
| `test/upward-interrupt-and-speculate-e2e.test.ts` | `<= 400` | 1. Protocol 2 (`Upward Architectural Interrupt`, `CODING_SAMPLE.md` §5.2): `coordinator` dispatches parallel `delegate-partition` forks for `db` and `api`; `api` raises `contractViolation`; runtime pauses sibling forks in `repoTopology.affectedBy('db')`, returns `SUSPENDED_ON_INTERRUPT` to `coordinator`, `coordinator` updates `TECH_DESIGN.md`, `packages/db/src/index.ts`, and `repoTopology` contract, and calls `resumeFork` to rebase (`syncChild`) and complete both forks.<br>2. Protocol 3 (`Speculative Tournament with Deferred Escalation`, `CODING_SAMPLE.md` §5.3): `coordinator` invokes `explore-candidates`; Branch 0 parks on `normativeEscalation` (`PARKED_ON_ESCALATION`) while Branch 1 completes; verifies `candidateArbiter` is invoked (never short-circuiting), tests `'unpark-escalation'` (keeping Branch 1 alive while paging `owner` and resuming Branch 0) and `'select-winner'` with `refineWinnerWhen` cross-pollinating from the losing branch via `git.candidateComparisonTools` before committing the winner and flushing winner-only lesson outcomes. |
| `test/mutate-plan-rewind-and-recovery-e2e.test.ts` | `<= 400` | 1. Dynamic `.mutatePlan()` (`spawnTasks` with `suspend-and-yield-slot` and `inherit-parent-with-boost`): parent suspends, prerequisite runs and lands stacked PR branch `fix/#102`, parent wakes up, runs `syncRoot` and `syncRunOverlays`, lands stacked PR onto `fix/#102`, and when `changeShippedSignal` fires on merge to `main`, `commitOverlayWhen` commits both overlays and calls `LessonStore.syncCreationEpochsForRuns`.<br>2. Verifies `steerSignal` `.rewindTo('execute-work', { onRewind: git.keepWorktree() })` and reboot crash recovery (`getInterruptedStepsOnBoot`). |

---

## 6. Verification Gate Commands

Run from workspace root (plus the `IMPL_LOOP.md` `baseline_dirty` diff check against `<non_sibling_forbidden_dirs_excluding_upstream_patches>`):

```bash
pnpm --filter @harness-dsl/integration lint
pnpm --filter @harness-dsl/integration typecheck
pnpm --filter @harness-dsl/integration test -- --reporter=verbose
pnpm -r lint
pnpm -r typecheck
pnpm -r test -- --reporter=verbose
pnpm lint && pnpm typecheck && pnpm test
test -z "$(git status --porcelain -- docs .agents .claude package.json tsconfig.base.json vitest.config.ts)"
```
