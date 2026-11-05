# Milestone 4 (`M4`): End-to-End Reference Harnesses & Protocol Integration

## 1. Scope & Package Directory

- **Milestone Wave:** Sequential Wave 3 — End-to-End Integration (`b`) (Executes after `M1`, `M2`, and `M3a..M3f` pass all verification gates)
- **Owned Files & Directories:**
  - `packages/stripe/src/index.ts`
  - `packages/stripe/test/stripe.test.ts`
  - `packages/netsuite/src/index.ts`
  - `packages/netsuite/test/netsuite.test.ts`
  - `packages/integration/src/financial-harness.ts`
  - `packages/integration/src/engineering-harness.ts`
  - `packages/integration/src/index.ts`
  - `packages/integration/test/financial-harness.test.ts`
  - `packages/integration/test/protocol1-test-ratchet.test.ts`
  - `packages/integration/test/protocol2-contract-violation.test.ts`
  - `packages/integration/test/protocol3-speculative-tournament.test.ts`
  - `packages/integration/test/stacked-pr-and-crash-recovery.test.ts`
- **Forbidden Directories:**
  - Do not modify `infra/**`, `.claude/**`, `.agents/**`, `scripts/**`, or `docs/**`.

---

## 2. Exact Spec Grounding Table

Read the following sections in full before authoring any file in `M4`:

| Document | Section | Line Range | Key End-to-End Scenarios Covered |
| :--- | :--- | :--- | :--- |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §1–§4 Full Framework Specification | `1–1472` | All core runtime and peer adapter invariants |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §5 Domain-Generality Verification: Non-Coding Financial Harness Example | `1474–1583` | Complete `reconciliationFlow` over `@harness-dsl/stripe` and `@harness-dsl/netsuite` Tier-1 `IsolationScope` |
| [`docs/CODING_SAMPLE.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_SAMPLE.md) | §1–§5 Operational Invariants, `.harness/` Layout, CoW Worktree Hierarchy, Actor Matrix, Protocols 1–3 | `1–174` | All 5 operational invariants and Protocols 1, 2, and 3 |
| [`docs/CODING_SAMPLE.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_SAMPLE.md) | §6 Complete Production Implementation (`engineering-harness.ts`) | `176–1208` | Full `acme-engineering` production harness definition |

---

## 3. File-by-File Architecture & Exported Symbols

### 3.1 `packages/stripe/src/index.ts`

Implements the `@harness-dsl/stripe` domain adapter used by `SPEC.md` §5:

```ts
import { z } from 'zod';
import type { LeaseDelta, PolicyGuard, ToolDefinition } from '@harness-dsl/core';

export const stripe: {
  maxRefundGuardUsd(maxAmountUsd: number): PolicyGuard;
  allowRefundUpToUsd(maxAmountUsd: number): LeaseDelta;
  readTools(): readonly ToolDefinition<any>[];
};
```

### 3.2 `packages/netsuite/src/index.ts`

Implements the `@harness-dsl/netsuite` Tier-1 `IsolationScope` and accounting guards/checks used by `SPEC.md` §5:

```ts
import { z } from 'zod';
import type { AbortHook, Check, IsolationScope, PolicyGuard, ToolDefinition } from '@harness-dsl/core';

export interface NetSuiteDraftHandle {
  readonly kind: 'netsuite:draft-handle';
  readonly runId: string;
  readonly draftJournalId: string;
  entries: Array<{ readonly id: string; readonly amountUsd: number; readonly closedPeriod?: boolean }>;
  rolledBack: boolean;
}

export const DraftJournalReceiptSchema = z.object({
  draftJournalId: z.string(),
  netBalanceUsd: z.number(),
  entryCount: z.number(),
});
export type DraftJournalReceipt = z.infer<typeof DraftJournalReceiptSchema>;

export const DraftRollbackMetaSchema = z.object({
  rolledBackJournalId: z.string(),
});
export type DraftRollbackMeta = z.infer<typeof DraftRollbackMetaSchema>;

export const netsuite: {
  forbidClosedPeriodPosting(): PolicyGuard;
  rollbackDraftJournal(): AbortHook<NetSuiteDraftHandle, DraftRollbackMeta>;
  journalTools(): readonly ToolDefinition<NetSuiteDraftHandle>[];
  balanceZeroCheck(): Check<NetSuiteDraftHandle>;
  draftJournalScope(): IsolationScope<NetSuiteDraftHandle, DraftJournalReceipt>;
};
```

### 3.3 `packages/integration/src/financial-harness.ts`

Contains the exact non-coding financial reconciliation harness from `SPEC.md` §5 (lines 1478–1583), exporting `discrepancyItem`, `settlementReceipt`, `highValueApprovalRequest`, `reconcileLimitExceeded`, `financeController`, `autoReconcilePolicy`, `manualReconcilePolicy`, `reconciliationAgent`, `manualEscalationAgent`, and `reconciliationFlow`. Strip all `//` and `/* */` comments present in the `SPEC.md` §5 reference listing so `financial-harness.ts` contains zero comments in compliance with `CLAUDE.MD` line 20.

### 3.4 `packages/integration/src/engineering-harness.ts`

Contains the exact production coding workflow harness from `CODING_SAMPLE.md` §6 (lines 178–1208), exporting `workItem`, `workReceipt`, `evaluationResult`, `arbiterVerdictSchema`, `ownerDecisionSchema`, `forkRequestSchema`, `speculateRequestSchema`, `steerSignal`, `changeShippedSignal`, `prClosedUnmergedSignal`, `highLeverageLessonSignal`, `scopeTripwire`, `leaseRequest`, `contractViolation`, `normativeEscalation`, `runner`, `claudeAccounts`, `sonnet`, `opus`, `workerModels`, `ledger`, `slackBot`, `owner`, `repoTopology`, `repoPartitions`, `workspace`, `repoRules`, `repoLessons`, `dbMigrationSkill`, `uiVerificationSkill`, `workerBasePolicy`, `fastPathPolicy`, `coordinatorPolicy`, `engineeringPrefix`, `worker`, `evaluator`, `leaseAdjudicator`, `candidateArbiter`, `guardedWorker`, `verifiedWorkerLoop`, `coordinator`, `landChanges`, `checkExistingPr`, `publishPr`, `engineeringFlow`, `issuesTracker`, `engineeringLane`, and `appHarness`. Strip all `//` and `/* */` comments present in the `CODING_SAMPLE.md` §6 reference listing so `engineering-harness.ts` contains zero comments in compliance with `CLAUDE.MD` line 20.

---

## 4. Critical Implementation Invariants

1. **Zero Drift from Reference Listings (`SPEC.md` §5 & `CODING_SAMPLE.md` §6) & Zero-Comment Enforcement (`CLAUDE.MD` line 20):**
   - `financial-harness.ts` and `engineering-harness.ts` must match the builder chains, schema definitions, policy clauses, interrupt edges, and exports in `SPEC.md` §5 and `CODING_SAMPLE.md` §6 without omitting any method call or adding type casts/`any` workarounds, while stripping all `//` and `/* */` comments present in the `SPEC.md` §5 and `CODING_SAMPLE.md` §6 reference listings so that `financial-harness.ts` and `engineering-harness.ts` contain zero comments.
2. **End-to-End Deterministic Execution:**
   - All integration tests execute against real local temporary git repositories (`git.cowWorktree`), real WAL-mode SQLite databases (`sqlite.ledger`, `sqlite.topologyStore`, `sqlite.globalRules`), real host-root `fs.jsonlLessonStore` and `.harness/` Markdown rule/skill files (`@harness-dsl/markdown`), real `local.runner` subprocesses (`@harness-dsl/node`), and deterministic scripted `AnthropicFetchTransport` / `SlackBotTransport` / `GitHubFetchTransport` mocks driving `createHarnessRuntime(appHarness)`.

---

## 5. Required Test Suite (`packages/integration/test/*.test.ts`)

1. **`financial-harness.test.ts` (`SPEC.md` §5):**
   - Verifies Tier-1 `IsolationScope` (`netsuite.draftJournalScope()`) execution without git checkpoints or branching.
   - Verifies Clause 1 (`netsuite.forbidClosedPeriodPosting()`) denying closed-period postings in-band (`'deny-with-error'`).
   - Verifies Clause 2 (`stripe.maxRefundGuardUsd(500)`) intercepting a `$1,200` refund pre-flight, raising `highValueApprovalRequest` to `financeController` (`slack.bot`), granting `stripe.allowRefundUpToUsd(10_000)` upon approval, and replaying `PendingToolBatch.remainingCalls` in `(1..k)` declaration order.
   - Verifies `.maxTurns(6)` `.onLimitExceeded()` executing `LIMIT_EXCEEDED_FLUSH` (`toolChoice: 'none'`), running `netsuite.rollbackDraftJournal()`, and replacing the step with `manualEscalationAgent`.
2. **`protocol1-test-ratchet.test.ts` (`CODING_SAMPLE.md` §5.1):**
   - Verifies `verifySuite.asTool()` omitting `describeEffects` and `git.cowWorktree.diffEffects()` rolling back an unauthorized write to an existing `.test.ts` or boundary file made during a subprocess run.
   - Verifies `guardedWorker` creating a new `.test.ts` file freely (`onlyExistingAtBaseRef: true`) while editing an existing `.test.ts` file triggers `leaseRequest` -> `leaseAdjudicator`:
     - Case A: `leaseAdjudicator` approves -> `fs.allowWriteGlobs` attached to `agent-frame.activeLeases` and `loop-frame.grantedLoopLeases` (persisting across Iteration 2) and immediate `(1..k)` replay of `edit_file` + trailing `verifySuite.asTool()`.
     - Case B: `leaseAdjudicator` denies -> `[Lease Denied]` (`isError: true`) on `edit_file` and `[Skipped: Preceding tool call in turn batch was denied]` (`isError: true`) on trailing `verifySuite.asTool()`.
     - Case C: `leaseAdjudicator` raises `normativeEscalation` to `owner` -> nested `$esc.elevateLeaseWhen()` attaches `PRODUCT_SPEC.md` lease to outer `guardedWorker` while `$esc.resumeWith()` resumes `leaseAdjudicator` on `adjudicatorStack` before draining `guardedWorker`'s `remainingCalls`.
3. **`protocol2-contract-violation.test.ts` (`CODING_SAMPLE.md` §5.2):**
   - Verifies `coordinator` dispatching concurrent `api` and `db` downward forks (`delegate-partition`).
   - Verifies `api` worker (and separately `evaluator` rolling back to `preservedActLeafMessageId`) raising `contractViolation` targeting `'db'`, pausing the concurrent `'db'` sibling fork across both `TOOL_BOUNDARY` (Case B, including canceling an in-flight `owner` escalation via `slackBot.cancelDecision`) and `BEFORE_STOP_GATE` (Case C with `neutralSyncContinuation: true`), and returning normal `SUSPENDED_ON_INTERRUPT` and `PAUSED_BY_SIBLING_INTERRUPT` wire `tool_result`s to `coordinator`.
   - Verifies `coordinator`'s built-in open-fork `beforeStop` gate rejecting completion while `SuspendedForkRecord`s remain open, `coordinator` updating the `'db'` contract in `repoTopology`'s per-run CoW overlay and editing `packages/db/src/index.ts` (auto-flushed onto `parent.HEAD`), and calling `resumeFork` with multiple `suspendedForkIds` (`{ results }` wire aggregation) to run `syncChild`, inject `[TOPOLOGY_SYNC]` / `[TOPOLOGY_SYNC_REVERIFY]` / `[CONTRACT_VIOLATION_RESOLVED]`, complete `evaluator`, and commit via `commitChild`.
4. **`protocol3-speculative-tournament.test.ts` (`CODING_SAMPLE.md` §5.3):**
   - Verifies `.speculate('explore-candidates', ...)` where Branch 0 parks on `normativeEscalation` (`PARKED_ON_ESCALATION`) and Branch 1 completes (`COMPLETED`).
   - Verifies `.speculate()` refusing to short-circuit arbitration when Branch 0 is parked, running `crossTester` (`git.publicSurfaceCrossTester`) and `candidateArbiter`.
   - Verifies `candidateArbiter` returning `decision: 'unpark-escalation'` (`parkedBranchIndex: 0`), retaining Branch 1's completed worktree handle alive on disk, paging `owner` via `slackBot`, recording the ruling in `humanRulingsHistory`, resuming Branch 0 to completion, re-running `candidateArbiter` to select a winner with `followUpDeficits`, running `refineWinnerWhen` with `git.candidateComparisonTools` (`evalInCandidates` rolling back temporary benchmark mutations via `try/finally`), and committing the refined winner (`WINNER_COMMITTED` persisted before flushing lesson outcomes).
5. **`stacked-pr-and-crash-recovery.test.ts`:**
   - Verifies fast-path `scopeTripwire` (`fs.maxFilesMutated(4)`) executing `LIMIT_EXCEEDED_FLUSH`, `git.snapshotAndReset()` (`refs/harness/aborted/<run-id>/<stepExecId>`), and `.replaceWith(coordinator)` inspecting the aborted ref via `git.refReaderTools`.
   - Verifies `coordinator` invoking `spawnTasks` (`[#101, #102]`), linear chaining ($#101 \leftarrow #102 \leftarrow #100$), `suspend-and-yield-slot` with `headScopeCheckpoint`, priority-boosted prerequisite execution, `'SUSPENDED'` wakeup (`restoreCheckpoint` + `syncRunOverlays` + `syncRoot`), `landChanges` (`git.commitAndPush`), `publishPr` targeting `--base fix/#102`, and `changeShippedSignal` (`baseBranch: 'fix/#102'` folding into `#102` overlay vs `baseBranch: 'main'` committing 3-way overlay and updating `LessonStore.syncCreationEpochsForRuns`).
   - Verifies `steerSignal` triggering the 4-step Hierarchical Rewind Drain Barrier on both active and `'SUSPENDED'` runs.
   - Verifies full process crash recovery (`recoverInterruptedRunsOnBoot()`) across simulated mid-step crashes.

---

## 6. Verification Gate Commands

```bash
pnpm check:comments
pnpm --filter @harness-dsl/stripe typecheck
pnpm --filter @harness-dsl/stripe test
pnpm --filter @harness-dsl/netsuite typecheck
pnpm --filter @harness-dsl/netsuite test
pnpm --filter @harness-dsl/integration typecheck
pnpm --filter @harness-dsl/integration test
pnpm -r typecheck
pnpm -r test
```
