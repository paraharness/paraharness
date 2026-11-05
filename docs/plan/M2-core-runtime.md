# Milestone 2 (`M2`): `@harness-dsl/core` Runtime State Machine & Orchestration Engine

## 1. Scope & Package Directory

- **Milestone Wave:** Sequential Core Spine (`b`) — Wave 1b (Depends on Wave 1a `M1`; completes and freezes `@harness-dsl/core` before Wave 2 `M3a..M3f` starts)
- **Owned Files & Directories:**
  - `packages/core/src/runtime/locks.ts`
  - `packages/core/src/runtime/prefix-compiler.ts`
  - `packages/core/src/runtime/pool-scheduler.ts`
  - `packages/core/src/runtime/lessons-engine.ts`
  - `packages/core/src/runtime/service-manager.ts`
  - `packages/core/src/runtime/policy-engine.ts`
  - `packages/core/src/runtime/agent-runner.ts`
  - `packages/core/src/runtime/fork-supervisor.ts`
  - `packages/core/src/runtime/speculate-supervisor.ts`
  - `packages/core/src/runtime/loop-runner.ts`
  - `packages/core/src/runtime/flow-runner.ts`
  - `packages/core/src/runtime/lane-scheduler.ts`
  - `packages/core/src/runtime/harness-runtime.ts`
  - `packages/core/src/runtime/index.ts`
  - `packages/core/test/runtime-locks-prefix.test.ts`
  - `packages/core/test/runtime-lessons-skills.test.ts`
  - `packages/core/test/runtime-policy-replay.test.ts`
  - `packages/core/test/runtime-fork-interrupts.test.ts`
  - `packages/core/test/runtime-speculate.test.ts`
  - `packages/core/test/runtime-loop-flow-lane.test.ts`
  - `packages/core/test/runtime-crash-recovery.test.ts`
- **Forbidden Directories:**
  - Do not modify `packages/core/src/ports.ts`, `packages/core/src/schemas.ts`, `packages/core/src/ast.ts`, `packages/core/src/json-schema.ts`, `packages/core/src/builders.ts`, `packages/core/src/index.ts`, or root workspace configuration files frozen in `M1`.
  - Do not touch any adapter package directory (`packages/sqlite`, `packages/postgres`, `packages/fs`, `packages/markdown`, `packages/node`, `packages/git`, `packages/claude`, `packages/openai`, `packages/github`, `packages/slack`, `packages/stripe`, `packages/netsuite`, `packages/integration`).

---

## 2. Exact Spec Grounding Table

Read the following sections in full before authoring any file in `M2`:

| Document | Section | Line Range | Key Runtime Semantics Covered |
| :--- | :--- | :--- | :--- |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §1.2 Declarative Compilation & Serialization Invariants | `25–33` | Host-root storage resolution, run-immutable wire prefix invariant, Turn-0 and delta frame injection |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §2.3–§2.7 Port Contracts & Continuation Frames | `149–869` | `ContinuationFrame` variants (`agent-frame`, `loop-frame`, `fork-batch-frame`, `speculate-frame`), `PendingToolBatch`, `SuspendedForkRecord`, `LedgerStore`, `TopologyStore`, `LessonStore` |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §3.1–§3.3 Signals, Pools, `H.prefixGroup` & `H.topology` | `875–924` | Run-sticky seat affinity, model escalation, `CompiledWirePrefix`, `updatedGroundingDiffs`, `commitOverlayWhen` 3-way overlay lifecycle |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §3.4 Contextual Knowledge (`H.rules`, `H.skill`, `H.lessons`) | `925–994` | Pre-flight & reactive scoped rules, reference-counted skill services & quiescing, per-`callId` tombstones, 4-state lesson attribution, scoring math, retirement, promotion signals |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §3.5–§3.6 `H.policy`, Post-Flight Diffing, Tool Replay & `H.human` | `995–1036` | `'deny-with-error'` precedence, `PendingToolBatch` `(1..k)` replay, `inFlightPreToolCheckpoint` rollback, nested `.adjudicateWith()`, 4-step `.onLimitExceeded()` |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §3.7 `H.agent`, `ScopeLockManager`, `.fork()`, `.speculate()`, `.mutatePlan()`, `.onChildInterrupt()` | `1037–1241` | `beforeStop` gates, `ScopeLockManager`, conflict-bouncing `commitChild`, `PARKED_ON_ESCALATION` & `unpark-escalation`, linear-chained `spawnTasks` & `syncRoot`, `suspendAndReturnToParent` & `resumeFork` Cases A/B/C |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §3.8–§3.10 `H.loop`, `H.flow`, `H.lane`, Rewind Drain & Crash Recovery | `1242–1325` | `actTurnsTaken`/`actCostUsd` separation, cross-model `prepareFork`, `.replaceWith()` cleanup, 4-step Hierarchical Rewind Drain Barrier, `getInterruptedStepsOnBoot` |
| [`docs/CODING_SAMPLE.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_SAMPLE.md) | §1, §4, §5 Operational Invariants & Protocols 1–3 | `3–18, 130–173` | End-to-end actor interactions across Protocols 1, 2, and 3 |

---

## 3. File-by-File Architecture & Exported Symbols

### 3.1 `packages/core/src/runtime/locks.ts`

```ts
import type { ContinuationFrame, LedgerStore } from '../ports.js';

export class ScopeLockManager {
  acquireRead<T>(handle: unknown, fn: () => Promise<T>): Promise<T>;
  acquireWrite<T>(handle: unknown, fn: () => Promise<T>): Promise<T>;
}

export class StepContinuationQueue {
  constructor(ledger: LedgerStore);
  enqueueUpdate(
    runId: string,
    stepExecId: string,
    mutator: (currentStack: readonly ContinuationFrame[]) => readonly ContinuationFrame[] | Promise<readonly ContinuationFrame[]>,
  ): Promise<readonly ContinuationFrame[]>;
  setInitialStack(stepExecId: string, stack: readonly ContinuationFrame[]): void;
  getCurrentStack(stepExecId: string): readonly ContinuationFrame[];
}
```

### 3.2 `packages/core/src/runtime/prefix-compiler.ts`

```ts
import type { CompiledWirePrefix, LeaseDelta, PolicyGuard, ResolutionContext, TopologyPartitionState } from '../ports.js';
import type { AgentDef, PrefixGroupDef, RulesDef } from '../ast.js';

export function compileRunWirePrefixes(opts: {
  readonly runId: string;
  readonly prefixGroups: readonly PrefixGroupDef[];
  readonly memberAgents: readonly AgentDef<any, any, any>[];
}): Promise<Readonly<Record<string, CompiledWirePrefix>>>;

export function computeUpdatedGroundingDiffs(opts: {
  readonly compiledPrefix: CompiledWirePrefix;
  readonly prefixGroup: PrefixGroupDef;
  readonly ctx: ResolutionContext;
  readonly policyGuards: readonly PolicyGuard[];
  readonly activeLeases: readonly LeaseDelta[];
}): Promise<Readonly<Record<string, string>>>;

export function formatRoleAndScopeContextFrame(opts: {
  readonly actorId: string;
  readonly roleKey: string;
  readonly instructionsText: string;
  readonly groundingTexts: readonly string[];
  readonly updatedGroundingDiffs: Readonly<Record<string, string>>;
  readonly topologyPartitions?: ReadonlyMap<string, TopologyPartitionState>;
  readonly preFlightScopedRules: ReadonlyArray<{ readonly id: string; readonly directive: string }>;
  readonly recalledLessons: ReadonlyArray<{ readonly id: string; readonly partition?: string; readonly directive: string }>;
  readonly skillCatalog: ReadonlyArray<{ readonly id: string; readonly description: string; readonly highlighted?: boolean }>;
  readonly allowedRoleTools?: readonly string[];
  readonly prerequisiteFailureNotes?: readonly string[];
}): string;
```

### 3.3 `packages/core/src/runtime/pool-scheduler.ts`

```ts
import type {
  AccountSeatDescriptor,
  ModelDescriptor,
  ModelDriver,
  PoolCandidateState,
  PoolSelectionContext,
  PoolSelectorFn,
  PoolStrategyPort,
} from '../ports.js';
import type { PoolDef } from '../ast.js';

export interface ResolvedModelSeat {
  readonly modelId: string;
  readonly driver: ModelDriver;
  readonly accountId?: string;
  readonly accountConfig?: AccountSeatDescriptor | unknown;
  readonly effort?: 'low' | 'medium' | 'high';
}

export class PoolScheduler {
  resolveModelForTurn(opts: {
    readonly runId: string;
    readonly modelOrPool: ModelDescriptor | PoolDef<any> | unknown;
    readonly retryAttempt: number;
    readonly effortOverride?: 'low' | 'medium' | 'high';
  }): ResolvedModelSeat;
  reportSeatRateLimited(runId: string, accountId: string, resetAtMs?: number): void;
  recordModelSample(modelId: string, succeeded: boolean): void;
  releaseRunAffinity(runId: string): void;
}
```

### 3.4 `packages/core/src/runtime/lessons-engine.ts`

```ts
import type { LessonOutcome, LessonRecord, TopologyPartitionState } from '../ports.js';
import type { LessonsDef } from '../ast.js';

export function scoreLessonCandidate(opts: {
  readonly lesson: LessonRecord;
  readonly activePartitions: readonly string[];
  readonly topologyPartitions: ReadonlyMap<string, TopologyPartitionState>;
  readonly windowSizeK: number;
  readonly partitionMatchBoost: number;
  readonly decayGamma: number;
}): number;

export function selectRecalledLessons(opts: {
  readonly candidates: readonly LessonRecord[];
  readonly activePartitions: readonly string[];
  readonly topologyPartitions: ReadonlyMap<string, TopologyPartitionState>;
  readonly lessonsDef: LessonsDef<any>;
}): ReadonlyArray<{ readonly id: string; readonly partition?: string; readonly directive: string; readonly score: number }>;

export function mergeLessonOutcome(
  existing: LessonOutcome | undefined,
  incoming: LessonOutcome,
): LessonOutcome;

export function shouldRetireLesson(opts: {
  readonly lesson: LessonRecord;
  readonly windowSizeK: number;
  readonly maxViolations?: number;
  readonly minCleanPassRate?: number;
  readonly afterInjections?: number;
}): boolean;

export function evaluateLessonPromotionSignal(opts: {
  readonly lesson: LessonRecord;
  readonly signalId: string;
  readonly minCleanPasses: number;
  readonly maxViolations: number;
  readonly cooldownHours: number;
  readonly nowMs: number;
}): boolean;
```

### 3.5 `packages/core/src/runtime/service-manager.ts`

```ts
import type { Service, ServiceSession } from '../ports.js';

export class StepServiceManager {
  acquireSkillServices(opts: {
    readonly runId: string;
    readonly scopeKey: string;
    readonly scopeHandle: unknown;
    readonly skillId: string;
    readonly services: readonly Service[];
  }): Promise<readonly ServiceSession[]>;
  releaseSkillServices(scopeKey: string, skillId: string): Promise<void>;
  quiesceAllForScopeKey(scopeKey: string): Promise<readonly string[]>;
  reacquireActiveSkills(opts: {
    readonly runId: string;
    readonly scopeKey: string;
    readonly scopeHandle: unknown;
    readonly activeSkillIds: readonly string[];
    readonly resolveServicesForSkill: (skillId: string) => readonly Service[];
  }): Promise<readonly string[]>;
}
```

### 3.6 `packages/core/src/runtime/policy-engine.ts`, `agent-runner.ts`, `fork-supervisor.ts`, `speculate-supervisor.ts`, `loop-runner.ts`, `flow-runner.ts`, `lane-scheduler.ts`, `harness-runtime.ts`, `index.ts`

```ts
import type { ConfigurableLedgerStore, HarnessRuntimeController } from '../ports.js';
import type { FlowDef, HarnessDef, LaneDef } from '../ast.js';
import { registerStepExecutors } from '../builders.js';

export interface CreateHarnessRuntimeOptions {
  readonly hostRootDir?: string;
}

export interface HarnessRuntime extends HarnessRuntimeController {
  start(): Promise<void>;
  stop(): Promise<void>;
  enqueueToLane<TIn>(
    laneId: string,
    item: TIn,
    opts?: { readonly priorityBoost?: number; readonly parentRunId?: string },
  ): Promise<string>;
  runFlowOnce<TIn, TOut = unknown>(
    flow: FlowDef<TIn, any, any, any, any>,
    input: TIn,
    opts?: { readonly runId?: string; readonly itemKey?: string },
  ): Promise<{
    readonly runId: string;
    readonly status: string;
    readonly output?: TOut;
  }>;
  recoverInterruptedRunsOnBoot(): Promise<void>;
}

export function createHarnessRuntime(
  harness: HarnessDef,
  opts?: CreateHarnessRuntimeOptions,
): HarnessRuntime;

export { ScopeLockManager, StepContinuationQueue } from './locks.js';
export {
  compileRunWirePrefixes,
  computeUpdatedGroundingDiffs,
  formatRoleAndScopeContextFrame,
} from './prefix-compiler.js';
export { PoolScheduler, type ResolvedModelSeat } from './pool-scheduler.js';
export {
  scoreLessonCandidate,
  selectRecalledLessons,
  mergeLessonOutcome,
  shouldRetireLesson,
  evaluateLessonPromotionSignal,
} from './lessons-engine.js';
export { StepServiceManager } from './service-manager.js';
```

At module load in `packages/core/src/runtime/index.ts` (and inside `createHarnessRuntime`), `M2` calls `registerStepExecutors({ executeAgent, executeLoop })` from `../builders.js` so `AgentDef.execute` and `LoopDef.execute` delegate directly to `M2`'s `AgentRunner` and `LoopRunner` without modifying `packages/core/src/builders.ts` or `packages/core/src/index.ts`.

---

## 4. Critical Implementation Invariants

### 4.1 `ScopeLockManager` & Serialized `ContinuationFrame[]` Persistence (`SPEC.md` §2.6, §3.7.2)

1. **`ScopeLockManager`:**
   - `acquireRead(handle, fn)` is acquired around `BranchableScope.forkChild`, `IsolationScope.inspect`, and parent tool executions whose `describeEffects` return only non-mutating effects (`effect.mutatesScope !== true`). Multiple readers on the same `handle` execute concurrently.
   - `acquireWrite(handle, fn)` is acquired around `BranchableScope.commitChild`, `BranchableScope.syncChild`, `BranchableScope.syncRoot`, and parent tool executions whose `describeEffects` include `mutatesScope: true` or omit `describeEffects`. Writers wait for all active readers/writers and exclude new readers/writers until completion.
2. **Per-`stepExecId` `StepContinuationQueue`:**
   - Every mutation to a step's `ContinuationFrame[]` tree (including concurrent child forks updating `'fork-batch-frame'`, speculative branches updating `'speculate-frame'`, and lease/skill/effect/lesson accumulators) is serialized through an in-memory async queue keyed by `stepExecId` before invoking `LedgerStore.updateContinuationStack(runId, stepExecId, continuationStack)`.

### 4.2 Run-Immutable `CompiledWirePrefix`, Grounding Diffs, `PoolScheduler` & Turn-0 Frame (`SPEC.md` §1.2, §3.2.1, §3.3)

1. **Declaration-Order Compilation & Pinning:**
   - At run start, `@harness-dsl/core` compiles each `H.prefixGroup` in strict AST declaration order: `.sharedGrounding(...)` sources, `.sharedInstructions(...)` sources, and `.sharedRules(...)` global rules (loaded with `ctx.scopeHandle` omitted so paths resolve against the immutable host root).
   - `CompiledWirePrefix.groundingSnapshots` stores `{ sourceId, text, digest }` for each `.sharedGrounding()` source.
   - In `'role-scoped'` mode, `wireToolSchemasByRoleKey[roleKey]` stores the actor's or `.withTools()` clone's own tools, skill tools (`activateSkill`, `completeSkill`, and `.unlocksTools()` / `Service.toolSchemas` tagged with `[Requires active skill: <id>]`), and capability tools (`delegate-partition`, `explore-candidates`, `spawnTasks`, `addDependencies`, `updatePartitionContract`, `resumeFork`, `.canRaise()`, `.escalate()`).
   - In `'union'` mode, `wireToolSchemasByRoleKey['*']` stores the deterministic union of all member actors' tool schemas, tagging role-restricted tools with `[Role: <actorId>]`.
   - `CompiledWirePrefix` is persisted in `LedgerStore.createOrResumeRun({ compiledPrefixesJson })` and never mutated mid-run.
2. **Worktree-Aware In-Run `updatedGroundingDiffs`:**
   - When building Turn-0 `[ROLE_AND_SCOPE_CONTEXT]` or `[TOPOLOGY_SYNC]` / `[PREREQUISITE_SYNC]` frames, the runtime reloads `.sharedGrounding()` sources with `{ ...ctx, scopeHandle }` for files unlocked by the active actor's policy or `activeLeases` and compares their content against `CompiledWirePrefix.groundingSnapshots`, emitting `updatedGroundingDiffs` into the user/tool frame without touching `systemPromptText`.
3. **`PoolScheduler` Run-Sticky Seat Affinity, HTTP `429` Failover, Empirical Model Escalation & Custom `PoolStrategy` (`SPEC.md` §3.2 lines 881–912):**
   - `PoolScheduler` inspects `ModelDescriptor` (`kind: 'harness:model'`, `accountPoolDef`) and `AccountSeatDescriptor` (`kind: 'harness:account-seat' | 'claude:account-seat' | 'openai:account-seat'`).
   - Pins a single account seat per `(runId, poolId)` across all turns and child forks within `runId` to preserve vendor KV caches and OpenAI `previous_response_id` state.
   - When `ModelDriver.invokeTurn` throws an error carrying `{ status: 429, resetAtMs?: number }`, `AgentRunner` calls `poolScheduler.reportSeatRateLimited(runId, accountId, err.resetAtMs)` and retries on the next available seat selected by `strategyConfig` (`'soonest-reset' | 'round-robin' | 'least-used' | 'custom'`), or falls back to `.fallback(account)` when all pooled seats are rate-limited (with `@harness-dsl/openai` stripping account-bound `previous_response_id`, `rs_...`/`fc_...`/`msg_...`, and `encrypted_content` on cross-seat failover).
   - Tracks per-model completion outcomes via `recordModelSample(modelId, succeeded)`. When `retryAttempt > 0` and `.escalateOnRetry().minSuccessRate(r).minSamples(n)` is configured on a model `PoolDef`, `resolveModelForTurn` skips any candidate model with $\ge n$ recorded samples whose empirical completion rate is $< r$, or escalates to the next model in `.models([...])` on retry.
   - When `strategyConfig.mode === 'custom'` (`customStrategy` is a `PoolStrategyPort<TItem>` or `PoolSelectorFn<TItem>`), `PoolScheduler` constructs `readonly PoolCandidateState<TItem>[]` (including `item`, `index`, `id`, `rateLimitedUntilMs`, `usageCount`, `lastUsedAtMs`, `successCount`, `sampleCount`, and `empiricalSuccessRate`) and `PoolSelectionContext` (`{ poolId, runId, retryAttempt, nowMs, stickyCandidateId }`), invokes `typeof customStrategy === 'function' ? customStrategy(candidates, ctx) : customStrategy.select(candidates, ctx)`, and falls back to `poolDef.fallbackItem` when the selector returns `undefined`.

### 4.3 `H.rules`, `H.skill` & `H.lessons` Runtime Semantics (`SPEC.md` §3.4.1–§3.4.3)

1. **Scoped Rules (`H.scopedRule`):**
   - Pre-flight Turn-0 injection: injects rules where `when.partitions` is non-empty and intersects `activePartitions`, recording `rule.id` in `injectedScopedRuleIds` on `agent-frame` (and `loop-frame`).
   - Deduplicated reactive effect injection: when `call_i` emits a `ToolEffect` matching `when.effects` and `rule.id` is not in `injectedScopedRuleIds`, appends `[SCOPED_RULE_ACTIVATED: ${rule.id}]\n${directive}` directly to `call_i`'s `completedResults` entry and records `rule.id` in `injectedScopedRuleIds`.
   - Crash-safe `beforeStop` enforcement: executes `rule.checks` during `beforeStop` whenever `rule.id` is in `injectedScopedRuleIds` and `observedEffects.some(e => e.mutatesScope === true)`.
2. **Skills (`H.skill`) & Reference-Counted Daemon Quiescing:**
   - Calling a tool unlocked by `skillId` while `!agentFrame.activeSkillIds.includes(skillId)` blocks the call pre-flight and returns `{ content: "Tool requires active skill '<skillId>'. Call activateSkill({ skillId: '<skillId>' }) first.", isError: true }`.
   - `activateSkill({ skillId })` loads skill instructions, acquires `.unlocksServices()` reference-counted by `service.id` across `activeSkillIds`, appends `skillId` to `agent-frame.activeSkillIds` (and `loop-frame.activeSkillIds` when called by `.act()`, keeping `.evaluate()` skill state isolated on the evaluator's `agent-frame`), records `{ messageId, callId }` in `activeSkillActivations[skillId]`, and returns the skill instructions.
   - `completeSkill({ skillId })` decrements service reference counts and stops any `ServiceSession` reaching count 0, removes `skillId` from `activeSkillIds`, looks up `{ messageId: activateMsgId, callId: activateCallId }` from `activeSkillActivations[skillId]`, deletes the entry, and invokes `LedgerStore.markFrameTombstone(runId, activateMsgId, activateCallId, "[Skill '<skillId>' completed and unmounted]")`.
   - Whenever `ModelDriver.prepareFork()` synthesizes new `WireFrameRecord` IDs, `activeSkillActivations[skillId].messageId` is remapped by matching `callId`.
   - Active `ServiceSession` daemons are stopped automatically at step boundaries (`.act() -> .evaluate()`, speculative branch completion) and on every suspension/park/abort transition (`SuspendedForkRecord`, `PARKED_ON_ESCALATION`, `suspend-and-yield-slot`, `onLimitExceeded`, `.replaceWith()`). Upon resume, unpark, wakeup, crash recovery, or loop-back from `'evaluate'` to `'act'`, services for `activeSkillIds` are re-acquired **before** draining `pendingToolBatch.remainingCalls`, and `[SERVICE_REACQUIRED: <serviceId> restarted on new port(s); in-memory session state reset]` is appended to the resuming `tool` or `user` frame via `ModelDriver.appendToolResultNotes`.
3. **Lessons (`H.lessons`) Scoring, 4-State Attribution, Distillation, Retirement & Signals:**
   - Scoring formula:
     $$\text{Score}(L, Q) = R(L, Q) \cdot (1 + \beta \cdot \mathbb{I}(L.\text{partition} \in P)) \cdot \gamma^{\max(0, E_{\text{now}} - E_0)} \cdot \left(\frac{c_W + 1}{c_W + 2v_W + 0.5g_W + 2}\right)$$
     where $E_{\text{now}} = \text{partitions.get}(L.\text{partition})?.\text{epoch} ?? 0$ and $E_{\text{now}} = E_0 = 0$ when $L.\text{partition}$ is `undefined`.
   - Precedence order: $\texttt{violated} \succ \texttt{gate\_rejected\_unrecovered} \succ \texttt{gate\_rejected\_recovered} \succ \texttt{clean\_pass}$.
   - In `H.loop.distillLessonsInto(lessons)`, `recalledLessons` on `loop-frame` are forwarded directly into the `.evaluate()` actor without re-querying `LessonStore`, and the evaluator's output schema is augmented with `_harnessMeta: z.object({ violatedLessonIds: z.array(z.string()).default([]) }).default({ violatedLessonIds: [] })` (stripped before returning domain output). Non-empty `violatedLessonIds` forces iteration rejection even if `acceptWhen(evalOut)` returned `true` and marks those lessons as `'violated'` in `accumulatedLessonOutcomes`.
   - Deduplicated flush (`1 outcome per (stepExecId, lessonId)`): flushed once when a top-level step completes `COMPLETED`, when a `.fork()` child records `CHILD_COMMITTED`, when a `.speculate()` tournament records `WINNER_COMMITTED` (merging `refineWinnerWhen` outcomes into `winnerBranchIndex` only if `refineWinnerWhen` completed `COMPLETED`), or when a loop exhausts `maxIterations` (`lessonsFlushed = true` before transitioning to `FAILED`). Discarded completely when a step aborts as `INTERRUPTED` (`.replaceWith()`) or on losing/aborted speculative branches.
   - Contrastive distillation (`.onLoopRecovery()` and `.onGateRecovery({ minFailedChecks })`) buffers candidate pairs in `bufferedGateRecoveries` and runs asynchronously only after `.evaluate()` accepts the iteration and (if in `.speculate()`) `WINNER_COMMITTED` is recorded. When distiller returns `admit: true`, `epochAtCreation` is read from `TopologyStore.getPartitions(ctx.runId)` with `createdByRunId: ctx.runId`.
   - Retirement: retires when `totalViolated >= maxViolations` OR when $\frac{c_W}{\max(N_{\text{eff}}, 1)} < \text{minRate}$ once $N_{\text{eff}} = c_W + v_W + g_W^{\text{unrecovered}} \ge m$ OR ($|W| \ge m \land N_{\text{eff}} \ge 1 \land \frac{c_W}{|W|} < \text{minRate}$).

### 4.4 `H.policy` Guard Clauses, Post-Flight Checkpoint Rollback, `PendingToolBatch` Replay & `.onLimitExceeded()` (`SPEC.md` §3.5)

1. **Clause Evaluation Precedence & Intra-Turn Batching:**
   - On every tool call, all `'deny-with-error'` clauses are evaluated in declaration order before any `'raise-interrupt'` clause.
   - At the start of a tool-calling turn `(1..k)`, `agent-frame.pendingToolBatch` is initialized with `completedResults: []`, `blockedCalls: []`, and `remainingCalls: (1..k)`. As each call `call_i` completes, it is atomically shifted from `remainingCalls` to `completedResults` in `LedgerStore`.
   - If call $i$ has `describeEffects`, passes all `'deny-with-error'` clauses, and fails `'raise-interrupt'` clause $C$, the runtime stops executing further calls, awaits `describeEffects` across `(i..k)`, includes in `blockedCalls` (and tags `blockedPreFlight: true` and `adjudicatedClauseIds: [...(call.adjudicatedClauseIds ?? []), C.id]`) only those calls in `(i..k)` that pass all `'deny-with-error'` clauses and fail the exact same clause $C$, constructs `violation = { blockedCalls, violatedEffects: blockedCalls.flatMap(c => c.violatedEffects), violationSummary: blockedCalls.map(c => c.violationSummary).join('; ') }`, persists `pendingToolBatch`, and raises `interrupt` via `mapper(violation)`.
2. **Post-Flight `inFlightPreToolCheckpoint` Sandboxing:**
   - For any tool omitting `describeEffects`, the runtime snapshots `preToolCkpt = await scope.serializeCheckpoint(scopeHandle)` and persists `agent-frame.inFlightPreToolCheckpoint = preToolCkpt` in `LedgerStore` before calling `tool.execute()`.
   - If `tool.execute()` throws or times out, the `catch` block unconditionally executes `await scope.restoreCheckpoint(scopeHandle, preToolCkpt)` before clearing `inFlightPreToolCheckpoint`.
   - After `tool.execute()` returns, `synthesizedEffects = await scope.diffEffects(preToolCkpt, scopeHandle)` is evaluated against policy clauses (`'deny-with-error'` first, then `'raise-interrupt'`). If disallowed, `await scope.restoreCheckpoint(scopeHandle, preToolCkpt)` rolls back the workspace without recording effects; for `'raise-interrupt'`, `{ callId: call_i.id, content: "[Post-Flight Policy Violation — Workspace Rolled Back: ${violationSummary}]", isError: true }` is shifted into `completedResults`, `activeInterruptCallId = call_i.id` is set, `remainingCalls` keeps `(i+1..k)`, and `inFlightPreToolCheckpoint` is cleared in the `updateContinuationStack` call.
3. **Nested `.adjudicateWith()` Lease Scope & Strict `(i..k)` Replay on `.resumeWith(feedback)`:**
   - Both outer `.elevateLeaseWhen()` and nested `$esc.elevateLeaseWhen()` inside `.adjudicateWith().onInterrupt()` attach granted `LeaseDelta`s to the **outer interrupted actor's** `agent-frame.activeLeases` and enclosing `loop-frame.grantedLoopLeases`, whereas `$esc.resumeWith()` resumes `pendingAdjudication.adjudicatorStack` until the adjudicator returns its verdict and the outer `.resumeWith(feedback)` runs.
   - Outer `.resumeWith(feedback)` persists `adjudicationFeedback: feedback`, updates `activeInterruptCallId` in `completedResults` (appending `\n[Adjudication: ${feedback}]` on post-flight rollback or shifting `{ callId: activeInterruptCallId, content: feedback }` on voluntary interrupt), clears `activeInterruptCallId = undefined`, and iterates `remainingCalls` strictly in `(i..k)` declaration order through the full per-call pipeline (prepending `[Lease Elevated: ${feedback}]\n\n` on `blockedPreFlight` calls, or recording `[Lease Denied: ${feedback}]` (`isError: true`) and skipping remaining calls with `[Skipped: Preceding tool call in turn batch was denied]` (`isError: true`) if a clause in `adjudicatedClauseIds` still fails).
4. **4-Step `.onLimitExceeded()` Sequence:**
   - Step 1: Synthesize `{ callId, content: '[Aborted: Limit Exceeded]', isError: true }` for any unexecuted calls in `remainingCalls`, clear `pendingToolBatch`, and append the complete `role: 'tool'` wire frame to `LedgerStore`.
   - Step 2: Set `pausedAtPhase = 'LIMIT_EXCEEDED_FLUSH'` and `limitExceededInterruptId = interrupt.id`, attach `[LIMIT_EXCEEDED_FLUSH]` via `ModelDriver.appendToolResultNotes` (or append a `user` frame if after a tool-less `assistant` turn), invoke 1 turn with `toolChoice: 'none'`, `effort: 'low'`, `outputSchema: interrupt.schema` while keeping `wirePrefix` intact, and persist `flushedInterruptPayloadJson`.
   - Step 3: Quiesce all active `'scope'`, `'fork'`, and `'skill'` daemons, execute `abortHook.execute(scopeHandle, runId, stepExecId)`, and call `TopologyStore.resetRunOverlay(runId, { scope: 'step', stepExecId })`.
   - Step 4: Transition step to `INTERRUPTED`, discard `accumulatedLessonOutcomes` and `bufferedGateRecoveries`, and route to `.onInterrupt(interrupt)`.

### 4.5 Downward `.fork()`, `.speculate()`, `.mutatePlan()`, `resumeFork`, `H.topology` & `H.lane` (`SPEC.md` §3.3, §3.7.2, §3.9, §3.10)

1. **`.fork()`, Downward `.modelRouting()` & `commitChild` Conflict Bounce:**
   - Preceding regular tool calls `(1..m)` and trailing calls `(p+1..k)` are persisted in parent `agent-frame.pendingToolBatch` before pushing `'fork-batch-frame'`.
   - When `.fork()` configures `.modelRouting(($m) => $m.inheritParentWithEffort(effort, { when }).otherwisePool(pool))` (`ForkCapabilityConfig.modelRouting`), `ForkSupervisor` evaluates `when(parentInput, req)`: when `true`, routes the child fork to the parent actor's resolved model weights with `effortOverride: effort`; when `false`, resolves the child fork's model from `otherwisePool` (`SPEC.md` §3.7.2 line 1066; `CODING_SAMPLE.md` lines 855–861).
   - On `commitChild` returning `status: 'clean'`, immediately persist `status: 'CHILD_COMMITTED'` with `outputJson` and `committedReceiptJson` in `LedgerStore` before calling `LessonStore.recordOutcomes()`, then flush lessons (`lessonsFlushed = true`) before `scope.release(childHandle)`.
   - On `commitChild` returning `status: 'conflict'`, increment `conflictRetryCount`, set `conflictCheckArmed = true`, roll `loop-frame` back to `'act'` at `preservedActLeafMessageId`, append `[COMMIT_CONFLICT]` (`res.conflictedSummary`), and re-run child (up to 2 retries).
2. **Upward `.onChildInterrupt()` Turn-Batch Barrier & `resumeFork` Cases A/B/C:**
   - Mint monotonic `suspendedForkId = "${forkId}#${suspensionEpoch}"`. If `raisedByPhase === 'evaluate'`, pop evaluator `agent-frame` and roll `loop-frame` back to `'act'` at `preservedActLeafMessageId`. Persist `pendingPauseTrigger` on `'fork-batch-frame'`.
   - Pause sibling forks in `pauseSiblingForksInPartitions`: if blocked on `HumanAdapter.requestDecision`, call `cancelDecision(runId, requestId)` and complete the trailing `role: 'tool'` frame with `[Paused by sibling interrupt — pending escalation cancelled; re-evaluate after topology sync]` (`isError: true`) before recording `pausedAtPhase: 'TOOL_BOUNDARY'`; if trailing message is a final structured-output `assistant` turn or inside `beforeStop`/`evaluator`, abort the gate/evaluator, roll back to `preservedActLeafMessageId`, and record `pausedAtPhase: 'BEFORE_STOP_GATE'`.
   - Built-in `beforeStop` gate on any parent declaring `.onChildInterrupt()` blocks parent completion while `LedgerStore.getSuspendedForks(runId, { parentStepExecId: ctx.stepExecId })` is non-empty.
   - `resumeFork`: aggregates multi-ID calls sharing `callId` into `{ results }` when `suspendedForkIds.length > 1`. On `action: 'resume'`, calls `restoreCheckpoint(childHandle, childScopeCheckpoint)` before `syncChild` if `syncedToParentCheckpoint` is not yet set, persists `syncedToParentCheckpoint` and `syncResultJson`, executes Case A (worker `tool_result` vs evaluator rollback `[CONTRACT_VIOLATION_RESOLVED]` user frame), Case B (`appendToolResultNotes` + `replaceMessageFrame`), or Case C (`[TOPOLOGY_SYNC_REVERIFY]` user frame with `neutralSyncContinuation: true`), re-acquires services before draining `remainingCalls`, runs enclosing `loop-frame`, and calls `resolveSuspendedFork("${forkId}#${epoch}", 'RESUMED')` on all terminal or re-suspended outcomes.
3. **`.speculate()` Tournament, Deterministic `forkId`, Case 3 `.verifyWinnerWith()` & Non-Destructive `unpark-escalation`:**
   - `SpeculateSupervisor` passes `forkId = "speculate-${callId}-branch-${branchIndex}"` to `BranchableScope.forkChild(parentHandle, forkId)` so `@harness-dsl/git` sets `childHandle.branchIndex = branchIndex` and registers live candidate worktrees for `inspect(handle)` and `candidateComparisonTools`.
   - Parks exogenous `H.human` escalations and unhandled upward interrupts as `PARKED_ON_ESCALATION`.
   - Post-Race Resolution Cases 1–4: never short-circuits when any sibling is parked, when $\ge 2$ branches are parked, or when `humanRulingsHistory.length > 0`:
     - When $\ge 2$ branches are `PARKED_ON_ESCALATION` with `0 COMPLETED`, routes to Case 4 arbitration (running `crossVerifyWith` if configured and invoking `.arbiter()`) rather than Case 2, so the arbiter selects which single parked branch to unpark first via `'unpark-escalation'` (`SPEC.md` §3.7.2 lines 1121–1139).
     - In Case 3 (`1 COMPLETED`, `0 PARKED_ON_ESCALATION`, `humanRulingsHistory.length === 0`), if `.verifyWinnerWith(evaluator, opts)` is configured on `SpeculateCapabilityConfig`, runs `evaluator` once on the sole surviving branch; if `acceptWhen(evalOut)` returns `false`, transitions that branch to `FAILED` and re-enters Case 1 (`0 COMPLETED`, `0 PARKED_ON_ESCALATION`) (`SPEC.md` §3.7.2 lines 1126–1130).
   - Built-in `beforeStop` gate on `arbiterAgent` verifies `winnerBranchIndex` for `'select-winner'` is `COMPLETED` and `parkedBranchIndex` for `'unpark-escalation'` is `PARKED_ON_ESCALATION`.
   - On `'unpark-escalation'`, retains all `COMPLETED` sibling handles alive, persists `phase = 'RACING'`, `status = 'RUNNING'`, and `pendingAdjudication.humanRequestId` before `HumanAdapter.requestDecision`, records ruling in `humanRulingsHistory`, and re-enters Cases 1–4 (or returns `ABORTED_ON_CHILD_INTERRUPT` if parked on an unhandled upward interrupt).
   - On `'select-winner'`, runs `refineWinnerWhen` (if matched) keeping losing worktrees alive until `commitChild` succeeds, snapshots `preRefinementCheckpoint` to fall back to pre-refinement winner if refinement fails or raises an unhandled interrupt, and persists `WINNER_COMMITTED` before flushing lessons.
4. **`.mutatePlan()` Linear Stacking Chain, `.canAddDependencies()`, `syncRoot` Wakeup & Prerequisite Failure Handling:**
   - Chains `spawnTasks` linearly ($T_{\text{prevTip}} \leftarrow T_1 \leftarrow \dots \leftarrow T_k \leftarrow T_{\text{parent}}$), enforces `maxSpawnedPerRun`, `maxPrerequisiteDepth` (default 3), and DAG acyclicity, snapshots `headScopeCheckpoint` on `SUSPENDED`, and boosts prerequisite priority (`inherit-parent-with-boost`).
   - `.canAddDependencies()` (`addDependencies` tool) validates DAG acyclicity and `maxPrerequisiteDepth <= 3` atomically in `LedgerStore`; if it adds an uncompleted same-lane prerequisite to the active `RUNNING` item, triggers the same `suspend-and-yield-slot` + `inherit-parent-with-boost` + `headScopeCheckpoint` snapshot sequence as `spawnTasks` (`SPEC.md` §3.7.2 line 1183).
   - When all prerequisites complete in `'completed'`, wakes up after re-acquiring a lane slot, runs `restoreCheckpoint(rootHandle, headScopeCheckpoint)` before `TopologyStore.syncRunOverlays` and `BranchableScope.syncRoot`, grants a temporary conflict write `LeaseDelta` in `activeLeases` matching `effect.attributes?.paths` against `syncRes.conflictedPaths` if `syncRoot` returns `status: 'conflict'`, appends `[PREREQUISITE_SYNC]` to `spawnTasksCallId` in `completedResults`, re-acquires services before draining `remainingCalls`, and clears `syncedToPrerequisiteCheckpoint = undefined` once `remainingCalls` drains.
   - When any spawned prerequisite exits in a non-success terminal state (`'abandoned'`, `'exhausted'`, `'cancelled'`), wakes up after re-acquiring a lane slot, skips `TopologyStore.syncRunOverlays` and `BranchableScope.syncRoot`, and appends `[PREREQUISITE_FAILED: Task <key> exited with '<state>']` (`isError: true`) to `spawnTasksCallId` in `completedResults` (and if `rewindPendingToStepId` was set while `'SUSPENDED'`, drains and rewinds to `targetStepId`, injecting the `[PREREQUISITE_FAILED]` notice into the rewound step's Turn-0 context) (`SPEC.md` §3.7.2 line 1182).
5. **`H.topology` Overlay Lifecycle, `H.lane.maxCostUsd` Serialization & `ConfigurableLedgerStore` Compaction:**
   - `H.topology.commitOverlayWhen`: calls `TopologyStore.sealRunOverlay(runId)` when a flow completes cleanly, `TopologyStore.commitRunOverlay(runId)` (and `LessonStore.syncCreationEpochsForRuns`) when `signal` fires with `baseBranch === 'main'`, `TopologyStore.syncRunOverlays(baseRunId, [runId])` when `signal` fires with `baseBranch !== 'main'`, and `TopologyStore.discardRunOverlay(runId)` when `discardOnSignal` fires (`prClosedUnmergedSignal`), when a run exits in a failure terminal state (`'abandoned'`, `'exhausted'`, `'cancelled'`), or when a `SEALED_UNMERGED` overlay exceeds `maxSealedAgeHours` (default `168`) (`SPEC.md` §3.3 line 919).
   - `H.lane.maxCostUsd(limitUsd, opts)`: serializes budget checks per `runId` via an in-memory per-run mutex so only one `HumanAdapter.requestDecision` is in flight per run at a time; when `approved === false`, transitions the run directly to `'cancelled'` via the 4-step Hierarchical Rewind Drain Barrier without entering `.retry()`; when `approved === true` and `increaseLimitToUsd` is omitted, defaults to `2 * currentLimit` (requiring `increaseLimitToUsd > currentCostUsd` when provided) and persists `approvedMaxCostUsd` in `LedgerStore` (`SPEC.md` §3.9 line 1306).
   - When `harness.ledgerStore` implements `ConfigurableLedgerStore` (`scheduleCompactionDeadline`, `processDueCompactions`), `HarnessRuntime` schedules compaction deadlines on configured signals and terminal exits (deferring stacked-PR runs with `scopeReceipt.baseBranch !== 'main'` via `awaitingMainMergeFromBranch` until the root prerequisite merges to `'main'`) and runs `processDueCompactions` (`SPEC.md` §3.10 line 1323).

---

## 5. Required Test Suite (`packages/core/test/runtime-*.test.ts`)

1. **`runtime-locks-prefix.test.ts`:**
   - Concurrent `ScopeLockManager.acquireRead` execution vs exclusive `acquireWrite` serialization.
   - `StepContinuationQueue` serializing concurrent child fork updates to `LedgerStore.updateContinuationStack`.
   - `compileRunWirePrefixes` AST declaration order, `'role-scoped'` vs `'union'` `[Role: <id>]` schemas, run-start `groundingSnapshots` pinning, and `computeUpdatedGroundingDiffs` without mutating byte 0 of `systemPromptText`.
   - `PoolScheduler` run-sticky seat affinity across turns and child forks, HTTP `429` seat rotation (`'soonest-reset'`, `'round-robin'`, `'least-used'`, and `.fallback(account)`), `.escalateOnRetry().minSuccessRate(r).minSamples(n)` empirical model escalation, and custom `PoolStrategyPort<TItem>` / `PoolSelectorFn<TItem>` selection on `H.pool().strategy(...)` with fallback to `.fallback(...)` when the custom selector returns `undefined`.
2. **`runtime-lessons-skills.test.ts`:**
   - Reference-counted `ServiceSession` acquisition across multiple skills, quiescing at `.act() -> .evaluate()` and suspension boundaries, re-acquisition before `remainingCalls` drain, `[SERVICE_REACQUIRED]` note injection, and `completeSkill` per-`callId` tombstone marking + `prepareFork` `messageId` remapping.
   - Lesson scoring formula, 4-state attribution precedence, evaluator `_harnessMeta.violatedLessonIds` forced rejection, `recordOutcomes: false`, deduplicated per-execution flush, exhausted-loop flush, aborted-step discard, `.onLoopRecovery()` / `.onGateRecovery()` buffering, `.retireAfter()` edge cases ($N_{\text{eff}} \ge m$ and $|W| \ge m \land N_{\text{eff}} \ge 1$), and `.emitSignalWhen()` cooldowns.
3. **`runtime-policy-replay.test.ts`:**
   - `'deny-with-error'` precedence before `'raise-interrupt'`, multi-call turn batching of identical `'raise-interrupt'` clause failures, post-flight `inFlightPreToolCheckpoint` rollback on subprocess violation or timeout/exception, nested `.adjudicateWith().onInterrupt()` outer-actor lease scope, strict `(1..k)` declaration-ordered `remainingCalls` replay (approved, denied with subsequent skip, and secondary downstream clause suspension), and 4-step `.onLimitExceeded()` (`LIMIT_EXCEEDED_FLUSH` with `toolChoice: 'none'`).
4. **`runtime-fork-interrupts.test.ts`:**
   - `.fork()` `'shared-prefix-only'` vs `'clone-transcript'`, downward `.modelRouting(($m) => $m.inheritParentWithEffort('medium', { when }).otherwisePool(pool))` predicate routing (`when === true` vs `when === false`), `commitChild` `CHILD_COMMITTED` persistence before lesson flush, conflict-bounce rollback to `preservedActLeafMessageId` with `[COMMIT_CONFLICT]`, `.onChildInterrupt()` turn-batch barrier pausing siblings at `TOOL_BOUNDARY` (canceling pending human decision) and `BEFORE_STOP_GATE` (rolling back evaluator), parent open-fork `beforeStop` gate, and `resumeFork` Cases A/B/C + multi-ID `callId` aggregation + `resolveSuspendedFork` across re-suspensions.
5. **`runtime-speculate.test.ts`:**
   - `.speculate()` Cases 1–4, deterministic `forkId = "speculate-${callId}-branch-${branchIndex}"`, Case 3 `.verifyWinnerWith(evaluator, { acceptWhen })` rejecting sole survivor into Case 1 (`FAILED`), $\ge 2$ `PARKED_ON_ESCALATION` with `0 COMPLETED` routing to Case 4 arbitration to select which branch to unpark first, non-short-circuiting on parked sibling or `humanRulingsHistory.length > 0`, arbiter `beforeStop` candidate index validation, non-destructive `unpark-escalation` keeping `COMPLETED` sibling handles alive, `ABORTED_ON_CHILD_INTERRUPT` on unhandled upward interrupt, and `refineWinnerWhen` with `preRefinementCheckpoint` fallback on failure.
6. **`runtime-loop-flow-lane.test.ts`:**
   - `H.loop` `actTurnsTaken`/`actCostUsd` separation vs total telemetry, cross-model `prepareFork` escalation, `H.flow` `.branch()` outer `branchStepId` keying, `.replaceWith()` flow input promotion & overlay/daemon cleanup, `H.topology` `.commitOverlayWhen()` 3-way stacked PR overlay folding & commit + `discardOnSignal` & `maxSealedAgeHours` discard, `H.lane` priority aging, `maxCostUsd` per-run serialization + `approved === false` direct `'cancelled'` drain + omitted `increaseLimitToUsd` defaulting to `2 * currentLimit`, linear-chained `spawnTasks` & `.canAddDependencies()` (`maxPrerequisiteDepth <= 3` + cycle rejection), `syncRoot` conflict temporary write lease, `[PREREQUISITE_FAILED]` wakeup skipping `syncRunOverlays`/`syncRoot`, `ConfigurableLedgerStore` compaction scheduling, and 4-step Hierarchical Rewind Drain Barrier (active and `'SUSPENDED'`).
7. **`runtime-crash-recovery.test.ts`:**
   - Reboot recovery via `getInterruptedStepsOnBoot()` across mid-step `inFlightPreToolCheckpoint`, `LIMIT_EXCEEDED_FLUSH`, `fork-batch-frame` (`CHILD_COMMITTED` before lesson flush, mid-`syncChild`), `speculate-frame` (`RACING` with `humanRequestId`, `REFINING_WINNER`, `WINNER_COMMITTED`), `'SUSPENDED'` mid-`syncRoot` (`headScopeCheckpoint` restore), and between-step runs.

---

## 6. Verification Gate Commands

```bash
pnpm check:comments
pnpm --filter @harness-dsl/core typecheck
pnpm --filter @harness-dsl/core test
```
