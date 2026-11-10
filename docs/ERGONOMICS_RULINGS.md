# Ergonomics Rulings, Surface Ledger & Canonical Benchmarks

## 1. Owner Rulings Ledger

### Round 1 Rulings

| ID | Badge | Package(s) | Ruling | Approved Contract Summary |
| :--- | :--- | :--- | :--- | :--- |
| **`P1`** | `[ADDITIVE]` | `@paraharness/core/runtime` | **`APPROVED`** (Option 2) | Export `runStep<TIn, TOut, THandle>(node, input, options: StepRunOptions<THandle>): Promise<TOut>` and `StepRunOptions` strictly from `@paraharness/core/runtime` (never re-exported from `@paraharness/core`), keeping `executeAgent`, `executeLoop`, `executeCommand`, and `executeStepNode` untouched as pure `NodeExecutor` functions. Requires `registry`; defaults `env` to `{}`, `activeLeases` to `[]` (not exposed), and derives `activePartitions` via `stepNode.extractPartitions?.(validatedInput) ?? []`. |
| **`P2`** | `[ADDITIVE]` | `@paraharness/core/runtime` | **`APPROVED`** (Option 2) | Export `runFlow<TIn, THandle>(flow, input, options: FlowRunOptions): Promise<FlowRunResult>` and `FlowRunOptions` strictly from `@paraharness/core/runtime` (never re-exported from `@paraharness/core`), keeping `executeFlow` untouched. Requires both `registry` and `ledger: MaybeBuilder<LedgerStoreASTNode>`; acquires and releases root scope and stops `'scope'` service sessions in `try / finally`. |
| **`P3`** | `[ADDITIVE]` | `@paraharness/core` | **`APPROVED`** | `LoopBuilder.act(stepId, actor)` unconditionally sets `inputSchema: actorNode.inputSchema` and `outputSchema: actorNode.outputSchema`, inherits `extractPartitions: state.extractPartitions ?? actorNode.extractPartitions`, and defaults `returnOutputFromStepId: state.returnOutputFromStepId ?? stepId`. |
| **`P4`** | `[ADDITIVE]` | `@paraharness/core` | **`REJECTED`** | Rejected under Gate `(z)` / `(y)`: `P.pool(id).with(...items)` and `.strategy('soonest-reset' \| 'round-robin' \| 'least-used')` remain the single canonical pool API; positional `P.pool(id, ...items)`, `.items()`, and `.soonestReset()` / `.roundRobin()` / `.leastUsed()` builder methods are rejected. |
| **`P5`** | `[ADDITIVE]` | `docs`, `@paraharness/git`, `@paraharness/github` | **`APPROVED`** (Docs-Only) | `GitCommitAndPushOptions<TIn>` and `GithubCreateOrUpdatePrOptions<TIn>` already define `inputSchema?: z.ZodType<TIn>`; update `docs/CODING_SAMPLE.md`, `packages/git/README.md`, and `packages/github/README.md` to pass `inputSchema:` in options (`0` code changes; `input`/`output` aliases and string shorthands rejected). |
| **`P6`** | `[ADDITIVE]` | `@paraharness/core`, `@paraharness/node`, `@paraharness/fs`, `@paraharness/git` | **`APPROVED`** | Export `DEFAULT_NODE_RUNNER_AST_NODE` (`{ type: 'node:runner', id: 'default-runner', slots: 4, maxDaemons: 4 }`) from `@paraharness/core` and make `runner?` optional on `fs.codingTools(runner?)`, `fs.readOnlyTools(runner?)`, `git.refReaderTools(runner?)`, `git.candidateComparisonTools(runner?)`, and `git.publicSurfaceCrossTester({ runner?, partitionMap })` (aligning `git.commitAndPush`, `local.command`, and `local.streamCheck` onto the same constant). |
| **`P7`** | `[ADDITIVE]` | `@paraharness/claude`, `@paraharness/openai`, `@paraharness/gemini` | **`APPROVED`** | Make `options?: { id?: string; effort?: 'low' \| 'medium' \| 'high' }` optional on `claude.model(alias, options?)`, `openai.model(alias, options?)`, and `gemini.model(alias, options?)` with `options?.id` defaulting to `alias` (2-string `model(alias, modelId)` overload and `account(id, apiKey?)` / `cliAccount(id, configDir?)` positional shorthands rejected). |
| **`P8`** | `[ADDITIVE]` | `@paraharness/core` | **`REJECTED`** | Rejected under Gate `(x)`: adding filesystem-specific `violatedPaths` to `PolicyViolation` in `@paraharness/core` violates `docs/SPEC.md` §1 domain-generality boundary. |
| **`P9`** | `[ADDITIVE]` | `@paraharness/core`, `@paraharness/core/runtime` | **`APPROVED`** | Widen `HarnessRuntimeOptions.registry?` to `Partial<RuntimeExecutorRegistry> \| RuntimeExecutorRegistrySlice \| readonly RuntimeExecutorRegistrySlice[]` and in `createRuntime` resolve all declared `TopologyNode`, `LessonsNode`, and `HumanNode` instances across `harnessNode` through `registry`, throwing fail-closed `Rule 5.4` errors if any declared store or channel factory is missing. |
| **`P10`** | `[ADDITIVE]` | `@paraharness/core`, `@paraharness/core/runtime` | **`APPROVED`** | Widen `HarnessRuntimeController.emitSignal` to accept `MaybeBuilder<SignalNode<TPayload>> \| string` and expose `HarnessRuntimeController.enqueue<TIn>(lane: MaybeBuilder<LaneNode<TIn, string>> \| string, item: TIn): Promise<void>` (`ADJ-1`). |
| **`P11`** | `[ADDITIVE]` | `@paraharness/core` | **`APPROVED`** | Make `crossSchema?: TCross` optional (defaulting to `z.unknown()`) on `SpeculationCandidateSchema` and `SpeculationInputSchema`, infer `TEvalIn`, `TEvalOut`, and `TReceipt` on `SpeculateCapabilityBuilder.verifyWinnerWith`, and preserve `TAdjIn` on `AdjudicateInterruptBuilder.onInterrupt`. |
| **`P12`** | `[ADDITIVE]` | `@paraharness/core` | **`APPROVED`** | Make `configure?` optional on `agent.onChildInterrupt(interrupt, configure?)` (defaulting `mode` to `'suspend-and-return-to-parent'`), accept bidirectional `MaybeBuilder<HumanNode<'bidirectional'>>` directly in `lane.maxCostUsd(limitUsd, humanOrApprover)` (defaulting `alias` to `` `${human.id}:budget-approver` `` and `outputSchema` to `P.BudgetApprovalSchema`), and add 3-arg `harness.onSignal(signal, human, messageMapper)` overload (`human.withName(alias, schema)` rejected). |
| **`P13`** | `[ADDITIVE]` | `@paraharness/git` | **`APPROVED`** | Make `options?: { repo?: string; dir?: string }` optional on `git.cowWorktree(options?)` defaulting `repo` to `'.'` and `dir` to `'.paraharness/worktree'` (`checkpointPolicy.excludeGlobs` builder change rejected). |
| **`P14`** | `[ADDITIVE]` | `@paraharness/node`, `@paraharness/fs` | **`APPROVED`** | Default `graceLinesAfterMatch` to `25` on `local.streamCheck(id).circuitBreakWhenStdout(pattern, options?)`; make `options?: { definitionsDir?: string; statsPath?: string; lockFile?: string }` optional on `fs.jsonlLessonStore(options?)` defaulting `definitionsDir` to `'.paraharness/lessons'`, `statsPath` to `` `${definitionsDir}-stats.json` ``, and `lockFile` to `` `${definitionsDir}.lock` `` (string overload rejected). |
| **`P15`** | `[ADDITIVE]` | `@paraharness/core` | **`APPROVED`** | Make `configure?` optional on `cap.fork(toolName, child, configure?)` (defaulting `historyMode` to `'shared-prefix-only'`, `requestSchema` to `child.inputSchema`, and `mapInput` to `(_p, req) => req`); add 1-arg overload on `speculate.arbiter(arbiterActor, options?)` when `TNewVerdict extends SpeculateArbiterDecision` preserving `ExtractSpeculationCandidate<TArbiterIn>` across both overloads. |
| **`P16`** | `[ADDITIVE]` | `@paraharness/core`, `@paraharness/core/runtime` | **`APPROVED`** | Pinpoint `.toAST()` missing-method diagnostics (naming the exact missing method) and fail-closed `Rule 5.4` errors when any declared `streamSources`, `controlPlanes`, `humanChannels`, or `trackers` registration is missing from `registry`. |
| **`P17`** | `[ADDITIVE]` | `docs` | **`APPROVED`** | Replace `.items(...)` with `.with(...)` in `packages/{claude,gemini,openai}/README.md`, add `runStep` and `runFlow` (`@paraharness/core/runtime`) examples to `README.md` and `site/index.md`, add `CustomDomainASTRegistry` guide to `packages/core/README.md`, and add `P.lane().tracker(...)` example to `packages/github/README.md`. |

### Round 2 Rulings

| ID | Badge | Package(s) | Ruling | Approved Contract Summary |
| :--- | :--- | :--- | :--- | :--- |
| **`R2-P1`** (`C1`) | `[ADDITIVE]` | `@paraharness/fs`, `docs`, `tests/integration` | **`APPROVED`** (Option A) | Export `fs.violatedPaths(violation: PolicyViolation): string[]` from `@paraharness/fs` (`fs` namespace and named export `violatedPaths`), extracting deduplicated string paths in first-seen order from `violation.violatedEffects` where `effect.kind === 'fs:effect'` and `Array.isArray(effect.attributes?.['paths'])`. Update `docs/SPEC.md` §4.3, `docs/CODING_SAMPLE.md`, `README.md`, `packages/core/README.md`, `packages/fs/README.md`, and `tests/integration/src/engineering/internal/map-lease-request-violation.ts`. |
| **`R2-P2`** (`C3`) | `[ADDITIVE]` | `@paraharness/github` | **`APPROVED`** (Option A) | Widen `GithubCreateOrUpdatePrOptions<TIn = unknown, TOut = unknown>` with `readonly outputSchema?: z.ZodType<TOut>` so `github.createOrUpdatePr(id, { ..., outputSchema })` infers `TOut` directly from `options.outputSchema` (defaulting `TOut = unknown` when omitted). |
| **`R2-P3`** (`C4`) | `[ADDITIVE]` | `@paraharness/core/runtime` | **`APPROVED`** (Option A) | Update `runStep<TStep extends StepASTNode = StepASTNode, THandle = unknown>(node: MaybeBuilder<TStep>, input: ExtractStepInput<TStep>, options: StepRunOptions<THandle>): Promise<ExtractStepOutput<TStep>>` in `@paraharness/core/runtime` and `docs/SPEC.md` §2.3 so `DomainStepASTNode` members with fixed output types (`GitCommitAndPushNode` -> `void`, `LocalStreamCheckNode` -> `{ ok: boolean; deficits: readonly string[] }`) infer accurately without altering `DomainStepASTNode`. |
| **`R2-P4`** (`C6`) | `[ADDITIVE]` | `docs` | **`APPROVED`** (Option A) | Declare `candidateArbiter` in `README.md` and `packages/core/README.md`, and align `verifiedWorkerLoop`, `.arbiter(candidateArbiter)`, `.maxCostUsd(20.0, owner)`, and `.onSignal(highLeverageLessonSignal, owner, ...)` in `README.md`, `packages/core/README.md`, and `docs/CODING_SAMPLE.md` with Round 1 rulings `P3`, `P12`, and `P15`. |
| **`R2-P5`** (`C2`) | `[ADDITIVE]` | `@paraharness/lockfile` | **`APPROVED`** (Option A) | Replace `heartbeatMs: 2_000` with `heartbeatIntervalMs: 2_000` in `packages/lockfile/README.md:37` to match `FileLockOptions`. |
| **`R2-C5`** | `[ADDITIVE]` | `@paraharness/core` | **`REJECTED`** | Rejected under Gate `(y)` & `(z)`: parameterizing `FlowNode` by `TStepOutputs` breaks `FlowBuilder.toAST()` covariance (`Record<string, never>` is not assignable to `Record<string, unknown>`) and adds 3 type parameters across `FlowNode`, `LaneNode`, and `runFlow`. |

---

## 2. Cumulative Added-Overloads & Exports Ledger Per Package

| Package | Round 1 Added Overloads | Round 1 Added Exports | Round 2 Added Overloads | Round 2 Added Exports | Cumulative Added Overloads | Cumulative Added Exports |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **`@paraharness/core`** | `+2` (`HarnessBuilder.onSignal`, `SpeculateCapabilityBuilder.arbiter`) | `+1` (`DEFAULT_NODE_RUNNER_AST_NODE`) | `0` | `0` | `2` | `1` |
| **`@paraharness/core/runtime`** | `0` | `+4` (`runStep`, `StepRunOptions`, `runFlow`, `FlowRunOptions`) | `0` | `0` | `0` | `4` |
| **`@paraharness/claude`** | `0` | `0` | `0` | `0` | `0` | `0` |
| **`@paraharness/openai`** | `0` | `0` | `0` | `0` | `0` | `0` |
| **`@paraharness/gemini`** | `0` | `0` | `0` | `0` | `0` | `0` |
| **`@paraharness/node`** | `0` | `0` | `0` | `0` | `0` | `0` |
| **`@paraharness/fs`** | `0` | `0` | `0` | `+1` (`violatedPaths` / `fs.violatedPaths`) | `0` | `1` |
| **`@paraharness/git`** | `0` | `0` | `0` | `0` | `0` | `0` |
| **`@paraharness/markdown`** | `0` | `0` | `0` | `0` | `0` | `0` |
| **`@paraharness/sqlite`** | `0` | `0` | `0` | `0` | `0` | `0` |
| **`@paraharness/postgres`** | `0` | `0` | `0` | `0` | `0` | `0` |
| **`@paraharness/github`** | `0` | `0` | `0` | `0` | `0` | `0` |
| **`@paraharness/slack`** | `0` | `0` | `0` | `0` | `0` | `0` |

---

## 3. Canonical `Tier A–D` Benchmark Trend Table & Snippets (Owned Exclusively by `loop-persona`)

### Quantitative Benchmark Trend Table

| Round | Tier | LOC | Imports | Manual Type Annotations | Persona Guesses / Lookups | Initial `tsc` Errors | Applied Rulings |
| :---: | :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| **Round 1 (Baseline)** | `Tier A (Zero-to-One)` | `75` | `2` | `1` | `4` | `3` | — |
| **Round 2** | `Tier A (Zero-to-One)` | **`52`** (`-23`) | **`3`** (`+1`) | **`0`** (`-1`) | **`0`** (`-4`) | **`0`** (`-3`) | `P1`, `P3`, `P7`, `P17` |
| **Round 1 (Baseline)** | `Tier B (Flow)` | `61` | `3` | `0` | `2` | `0` | — |
| **Round 2** | `Tier B (Flow)` | **`61`** (`0`) | **`3`** (`0`) | **`0`** (`0`) | **`0`** (`-2`) | **`0`** (`0`) | `P7`, `P13` |
| **Round 1 (Baseline)** | `Tier C (Harness)` | `61` | `5` | `0` | `2` | `1` | — |
| **Round 2** | `Tier C (Harness)` | **`61`** (`0`) | **`5`** (`0`) | **`0`** (`0`) | **`0`** (`-2`) | **`0`** (`-1`) | `P7`, `P13`, `P17` |
| **Round 1 (Baseline)** | `Tier D (Escape Hatch)` | `95` | `3` | `2` | `4` | `2` | — |
| **Round 2** | `Tier D (Escape Hatch)` | **`79`** (`-16`) | **`3`** (`0`) | **`2`** (`0`) | **`0`** (`-4`) | **`0`** (`-2`) | `P7`, `P11`, `P15`, `P17` |
| **Round 1 (Baseline)** | **Total / Aggregate** | **`292`** | **`13`** | **`3`** | **`12`** | **`6`** | — |
| **Round 2** | **Total / Aggregate** | **`253`** (`-39` / `-13.4%`) | **`14`** (`+1`) | **`2`** (`-1`) | **`0`** (`-12` / `-100%`) | **`0`** (`-6` / `-100%`) | `P1`, `P3`, `P7`, `P11`, `P13`, `P15`, `P17` |

### Canonical `Tier A (Zero-to-One)` Snippet (`tier-a.ts`)

```ts
import { P, z } from '@paraharness/core';
import { runStep } from '@paraharness/core/runtime';
import { claude, claudeExecutors } from '@paraharness/claude';

const TaskInput = z.object({
  taskId: z.string(),
  prompt: z.string(),
});

const TaskOutput = z.object({
  summary: z.string(),
});

const sonnet = claude.model('claude-sonnet-4-6');

const worker = P.agent('worker')
  .model(sonnet)
  .instructions('Implement the requested change.')
  .input(TaskInput)
  .output(TaskOutput);

const evaluator = P.agent('evaluator')
  .model(sonnet)
  .instructions('Audit the candidate implementation.')
  .input(
    z.object({
      task: TaskInput,
      candidate: TaskOutput,
    }),
  )
  .output(
    z.object({
      accepted: z.boolean(),
      deficits: z.array(z.string()),
    }),
  );

const verifiedLoop = P.loop('verified-loop')
  .maxIterations(3)
  .act('execute', worker)
  .evaluate('audit', evaluator, {
    mapInput: (task, candidate) => ({ task, candidate }),
    acceptWhen: (ev) => ev.accepted && ev.deficits.length === 0,
    feedbackMapper: (ev) => `Resolve:\n${ev.deficits.join('\n')}`,
  });

export async function runTierA() {
  const input = { taskId: 'task-1', prompt: 'Fix the bug' };
  const agentRes = await runStep(worker, input, { registry: claudeExecutors });
  const loopRes = await runStep(verifiedLoop, input, { registry: claudeExecutors });
  return { agentRes, loopRes };
}
```

### Canonical `Tier B (Flow)` Snippet (`tier-b.ts`)

```ts
import { P, z } from '@paraharness/core';
import { claude } from '@paraharness/claude';
import { git } from '@paraharness/git';

const TaskInput = z.object({
  taskId: z.string(),
  prompt: z.string(),
});

const DraftOutput = z.object({
  draft: z.string(),
});

const FinalOutput = z.object({
  approvedSummary: z.string(),
});

const needsEscalation = P.interrupt(
  'needs-escalation',
  z.object({ reason: z.string() }),
);

const sonnet = claude.model('claude-sonnet-4-6');

const drafter = P.agent('drafter')
  .model(sonnet)
  .instructions('Draft the solution.')
  .input(TaskInput)
  .output(DraftOutput)
  .canRaise(needsEscalation);

const fallbackDrafter = P.agent('fallback-drafter')
  .model(sonnet)
  .instructions('Fallback drafter with escalated context.')
  .input(TaskInput)
  .output(DraftOutput);

const finalizer = P.agent('finalizer')
  .model(sonnet)
  .instructions('Finalize the draft.')
  .input(z.object({ task: TaskInput, draft: z.string() }))
  .output(FinalOutput);

export const standaloneFlow = P.flow('standalone-flow')
  .input(TaskInput)
  .scope(git.cowWorktree())
  .step('draft', drafter, ($step) =>
    $step.onInterrupt(needsEscalation, ($intr) =>
      $intr.replaceWith(fallbackDrafter, (item, payload) => ({
        taskId: item.taskId,
        prompt: `${item.prompt}\nEscalated: ${payload.reason}`,
      })),
    ),
  )
  .step('finalize', finalizer, ($step) =>
    $step.inputFrom((item, steps) => ({
      task: item,
      draft: steps.draft.draft,
    })),
  )
  .exit('done');
```

### Canonical `Tier C (Harness)` Snippet (`tier-c.ts`)

```ts
import { P, z } from '@paraharness/core';
import { claude } from '@paraharness/claude';
import { git } from '@paraharness/git';
import { github } from '@paraharness/github';
import { sqlite } from '@paraharness/sqlite';

const TaskInput = z.object({
  taskId: z.string(),
  prompt: z.string(),
});

const sonnet = claude.model('claude-sonnet-4-6');
const opus = claude.model('claude-opus-4-6');

const modelPool = P.pool('model-pool')
  .with(sonnet, opus)
  .strategy('round-robin');

const worker = P.agent('worker')
  .model(modelPool)
  .instructions('Complete the task.')
  .input(TaskInput)
  .output(z.object({ summary: z.string() }));

const worktreeScope = git.cowWorktree();

const taskFlow = P.flow('task-flow')
  .input(TaskInput)
  .scope(worktreeScope)
  .step('work', worker)
  .exit('done');

const tracker = github.issues({
  repo: 'acme/repo',
  token: P.env('GITHUB_TOKEN'),
});

const trackedLane = P.lane('tracked-lane')
  .input(TaskInput)
  .key((item) => item.taskId)
  .tracker(tracker, ($t) =>
    $t.everySeconds(60).from((issue) => ({
      taskId: `#${issue.number}`,
      prompt: issue.title,
    })),
  )
  .runs(taskFlow)
  .concurrency(2)
  .priority('high');

const backgroundLane = P.lane('background-lane')
  .input(TaskInput)
  .key((item) => item.taskId)
  .runs(taskFlow)
  .concurrency(1)
  .priority('low');

export const multiLaneHarness = P.harness('multi-lane-harness')
  .ledger(sqlite.ledger('.harness/state.sqlite'))
  .pools(modelPool)
  .lanes(trackedLane, backgroundLane);
```

### Canonical `Tier D (Escape Hatch)` Snippet (`tier-d.ts`)

```ts
import { P, z, type BaseToolASTNode } from '@paraharness/core';
import { claude } from '@paraharness/claude';
import { git } from '@paraharness/git';

export interface CustomSearchToolNode extends BaseToolASTNode<'custom:search-tool', 'declared'> {
  readonly indexName: string;
}

declare module '@paraharness/core' {
  interface CustomDomainASTRegistry {
    tool: CustomSearchToolNode;
  }
}

const customSearchTool: CustomSearchToolNode = {
  type: 'custom:search-tool',
  name: 'custom_search',
  description: 'Search the custom domain index.',
  inputSchema: z.object({ query: z.string() }),
  effectTracking: 'declared',
  indexName: 'docs-index',
};

const TaskInput = z.object({
  taskId: z.string(),
  prompt: z.string(),
});

const TaskOutput = z.object({
  summary: z.string(),
});

const ArbiterVerdict = z.discriminatedUnion('decision', [
  z.object({
    decision: z.literal('select-winner'),
    winnerBranchIndex: z.union([z.literal(0), z.literal(1)]),
    rationale: z.string(),
  }),
  z.object({
    decision: z.literal('reject-all'),
    rationale: z.string(),
  }),
]);

const sonnet = claude.model('claude-sonnet-4-6');

const leafWorker = P.agent('leaf-worker')
  .model(sonnet)
  .tools(customSearchTool)
  .instructions('Execute leaf task.')
  .input(TaskInput)
  .output(TaskOutput);

const arbiter = P.agent('arbiter')
  .model(sonnet)
  .instructions('Judge speculative branches.')
  .input(P.SpeculationInputSchema(TaskInput, TaskOutput, git.ScopeReceiptSchema))
  .output(ArbiterVerdict);

export const escapeHatchCoordinator = P.agent('coordinator')
  .model(sonnet)
  .tools(customSearchTool)
  .instructions('Coordinate subtasks and speculative tournaments.')
  .input(TaskInput)
  .output(TaskOutput)
  .capabilities(($cap) =>
    $cap
      .fork('delegate', leafWorker)
      .speculate('race', ($s) =>
        $s
          .requestSchema(z.object({ strategyA: z.string(), strategyB: z.string() }))
          .worker(leafWorker)
          .branches(2, (parent, req) => [
            { taskId: parent.taskId, prompt: req.strategyA },
            { taskId: parent.taskId, prompt: req.strategyB },
          ])
          .arbiter(arbiter),
      ),
  );
```

---

## 4. Non-Ergonomic Adjacent Defects Ledger

1. **`ADJ-1` (`RESOLVED` — `packages/core/src/ports/harness-runtime-controller.ts`, `packages/core/src/runtime/engine/create-runtime.ts`, `packages/core/src/runtime/engine/internal/manage-harness-runtime-lifecycle.ts`, `packages/core/src/runtime/lane/lane-scheduler.ts`, `docs/SPEC.md` §2.8):** Added `controller.enqueue(lane, item)`, wired `createRuntime.start()` to recover interrupted runs on boot via `LaneScheduler.recoverBootRecord(bootRecord)`, poll declared lane trackers on boot and interval timers (cleared in `stop()`), and drain dependent `.waitFor()` and `spawnTasks` (`SUSPENDED`) runs across passes.
2. **`ADJ-2` (`RESOLVED` — `packages/core/src/runtime/pools/internal/create-memoized-runner-resolver.ts`, `packages/core/src/runtime/lane/internal/prepare-lane-item-flow-execution.ts`, `packages/core/src/runtime/lane/internal/resolve-lane-tracker-adapter.ts`, `packages/core/src/runtime/flow/internal/build-flow-step-execution-context.ts`):** Memoized `getRunner(n)` keyed by `n.id` per `RuntimeExecutorRegistry` across harness, lane tracker, scope, flow, and step contexts (`docs/SPEC.md:1401-1402`).
3. **`ADJ-3` (`RESOLVED` — `packages/core/src/builders/internal/create-loop-from-state.ts:94-97`):** `LoopBuilder.act()` inverted ternary resolved in Round 1 via `P3`.
4. **`ADJ-4` (`RESOLVED` — `packages/core/src/builders/create-pool-builder.ts:43-58`):** `PoolBuilder.with(...nextItems)` preserves `options?.strategy` and `options?.fallbackItem`.
5. **`ADJ-5` (`RESOLVED` — `packages/core/src/builders/create-stream-builder.ts:31-40`):** `StreamBuilder.source(streamSource)` preserves `options?.filterFn` and `options?.mapPayload` alongside `options?.signal`.
6. **`ADJ-6` (`RESOLVED` — `packages/{claude,gemini,openai}/README.md`):** Model package READMEs updated to `.with(...)` in Round 1 via `P17`.
7. **`ADJ-7` (`RESOLVED` — `packages/core/src/builders/pool-builder.ts:40`):** Updated `PoolBuilder.strategy` JSDoc to reference `.escalateOnRetry(options?)` on `$`.
8. **`ADJ-8` (`RESOLVED` — `packages/core/src/runtime/engine/internal/prepare-harness-runtime-state.ts`, `packages/core/src/runtime/lane/internal/resolve-lane-tracker-adapter.ts`):** Fail-closed `Rule 5.4` validation for missing `streamSources`, `controlPlanes`, `humanChannels`, and `trackers` executors resolved in Round 1 via `P9` / `P16`.
9. **`ADJ-9` (`RESOLVED` — `packages/core/src/runtime/pools/internal/create-memoized-runner-resolver.ts`):** `createMemoizedRunnerResolver` validates that duplicate `RunnerPoolASTNode` declarations sharing the same `id` declare identical `type`, `slots`, and `maxDaemons`, throwing a fail-closed `Rule 5.4` error on conflict.
10. **`ADJ-10` (`REJECTED` under Gate `(y)` — `packages/{claude,openai,gemini}/src/`):** `docs/SPEC.md` §4.1 (`lines 2669, 2681, 2693`) explicitly specifies `readonly apiKey?: string | EnvRef;` on `ClaudeAccountSeatNode`, `OpenAiAccountSeatNode`, and `GeminiAccountSeatNode`.
