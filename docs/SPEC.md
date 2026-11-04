# @harness-dsl Framework & Ecosystem Specification (V7)

# 1. Scope, Design Principles & Package Topology

`@harness-dsl` is a declarative, durable execution framework for orchestrating autonomous LLM actors, deterministic tools, lifecycle-bound services, and human escalations over isolated execution scopes.

The architecture enforces a strict boundary between **Execution Topology** (`@harness-dsl/core`) and **Environment/Vendor Adapters** (peer packages). `@harness-dsl/core` contains zero concepts specific to software engineering, source-code testing, POSIX filesystems (read/write/execute modes, file globs), OS subprocesses (`argv`, `stdin`, `stdout`, TCP ports), version control (git, commits, diffs, rebasing), relational databases, or LLM provider wire formats.

## 1.1 Package Boundaries

| Package | Responsibility |
| :--- | :--- |
| **`@harness-dsl/core`** | Declarative AST compilation, Run-Immutable Unified Warm-Fork Prefix compilation (`H.prefixGroup` with `'role-scoped'` and `'union'` tool modes), durable state machine transitions, reboot-safe hierarchical continuation call-stack (`ContinuationFrame[]`) persistence across composite steps (`H.loop`), capability-tiered isolation scope contracts (`IsolationScope`, `CheckpointableScope`, `BranchableScope`) with crash-recovery handle reattachment (`reattachRoot`, `reattachChild`), per-handle read/write scope locks, downward fork/join lifecycle (`historyMode: 'shared-prefix-only' \| 'clone-transcript'`) with conflict-bounce reconciliation, speculative execution tournaments with deferred exogenous escalation parking and non-destructive contested escalation arbitration (`select-winner` vs `unpark-escalation`), upward interrupt suspension (`suspendAndReturnToParent`) with native `resumeFork` resolution across all sibling states on a single parent timeline, loop-scoped capability lease inheritance with suspended pre-flight tool replay, quota tripwires, relational topology epoch tracking (`affectedBy`, `dependentsOf`) injected via Turn-0 role frames, explicit `.partitions()` extraction, capacity pool & priority-boosted prerequisite scheduling, deduplicated evidence-based lesson scoring math, and ledger lifecycle orchestration. |
| **`@harness-dsl/claude`** | `ModelDriver` implementation for Anthropic HTTP API and Claude CLI seat pools (`~/.claude-*` JSONL session synthesis, cryptographic `thinking` signature preservation, role-scoped vs union prefix wire assembly, `shared-prefix-only` vs `clone-transcript` fork preparation, cross-model fork-boundary tombstone substitution, and ephemeral KV-cache breakpoint injection). |
| **`@harness-dsl/openai`** | `ModelDriver` implementation for OpenAI Responses API (`previous_response_id` server-side branching, encrypted reasoning token retention, role-scoped vs union prefix wire assembly, and cross-model fork-boundary tombstone substitution) and Codex CLI seats. |
| **`@harness-dsl/node`** | Local OS process slot runner (`local.runner`), one-shot subprocess commands (`local.command`), streaming subprocess checks with regex circuit-breakers (`local.streamCheck`), framed PTY/pipe background services (`local.daemon`), and Model Context Protocol control-plane server (`mcp.server`). Subprocess `.asTool()` adapters omit static `describeEffects` so workspace mutations are always verified post-flight via `CheckpointableScope.diffEffects()`. |
| **`@harness-dsl/fs`** | Filesystem `EffectMatcher` globs, write-policy guards, file-count quota tripwires (`fs.maxFilesMutated`), regex/AST deterministic `Check` implementations, `Source<string>` file loaders, topology-to-glob partition maps (`fs.partitionMap`), host-root content-addressed lesson stores (`fs.jsonlLessonStore`), file telemetry collectors, and workspace-jailed file tool bundles. |
| **`@harness-dsl/git`** | Copy-on-Write (CoW) hierarchical git worktree scope (`git.cowWorktree`) implementing `BranchableScope` and `CheckpointableScope` with crash-recovery worktree reattachment (`reattachRoot`/`reattachChild`), portable CoW clone fallback (`cp -c` / `cp --reflink=always` -> `git worktree add` + `cp -al node_modules`), path-cache exclusion (`excludeFromCloneGlobs`), partition-scoped deterministic git-index/hash dirty working-tree checkpointing (`serializeCheckpoint` / `diffEffects`), zero-pollution conflict-bouncing `commitChild`/`syncChild`/`syncRoot`, stacked-PR `baseBranch` lineage tracking, host-pinned completion/aborted refs, snapshot-and-reset abort hooks (`git.snapshotAndReset`), lockfile-hash setup gates, isolated PR-branch reconciliation (`rebase-onto-base`) and cumulative landing merge trains (`batch-merge-train`), AST-gated public-boundary cross-verifiers, ref reader tools (`git.refReaderTools`), candidate comparison tools (`git.candidateComparisonTools`), and commit/push executables. |
| **`@harness-dsl/markdown`** | Frontmatter-aware `Source<T>` loaders emitting validated `GlobalRule`, `ScopedRule`, and `SkillDefinition` objects from Markdown files and directories (`@harness-dsl/markdown` translates frontmatter globs into `@harness-dsl/fs` matchers). |
| **`@harness-dsl/sqlite`** | Local WAL-mode SQLite implementations for `LedgerStore`, `TopologyStore`, `LessonStore`, and relational `Source<GlobalRule[]>`. |
| **`@harness-dsl/postgres`** | Distributed PostgreSQL implementations for `LedgerStore`, `TopologyStore`, `LessonStore`, and `Source<GlobalRule[]>`. |
| **`@harness-dsl/github`** | Issue tracker adapter (`TrackerAdapter`) and webhook event stream (`StreamSource`). |
| **`@harness-dsl/slack`** | Human notification transport and interactive Socket Mode escalation/signal adapter (`HumanAdapter`, `ControlPlaneAdapter`). |

## 1.2 Declarative Compilation & Serialization Invariants

1. **Static AST Compilation:** Every flow, loop, branch, prefix group, interrupt handler, and signal handler in `@harness-dsl/core` compiles at initialization time into a static, inspectable state-transition Abstract Syntax Tree (AST).
2. **Forbidden Imperative Closures in Control Flow:** Arbitrary async JavaScript closures are prohibited inside control-flow builders (`.branch()`, `.onInterrupt()`, `.onChildInterrupt()`, `.onSignal()`). Inline TypeScript callbacks in the DSL MUST be pure, synchronous projection mappers (`(state, event, telemetry, scopeReceipt) => nextState`) transforming validated Zod schemas.
3. **Opaque Environment References (`H.env`):** Secrets and environment variables are referenced via `H.env(key: string): EnvRef`. The AST compiler serializes only the symbolic `EnvRef` key; the secret value is resolved in-memory by the leaf adapter at invocation time and is never written to the ledger.
4. **Port-Driven I/O Isolation:** Asynchronous I/O occurs strictly inside leaf implementations of Core Port Interfaces (`StepExecutable`, `ToolDefinition`, `Service`, `Check`, `Source`, `IsolationScope`, `ModelDriver`, and storage ports).
5. **Host-Root Storage Port Resolution:** Harness-level storage ports (`LedgerStore`, `TopologyStore`, `LessonStore`) always resolve file paths against the harness host process root, never against an active `IsolationScope` worktree directory.
6. **Run-Immutable Wire Prefix Invariant:** Sources bound to `H.prefixGroup().sharedGrounding()` MUST be immutable for the duration of a flow run. Dynamic state that can mutate mid-run (such as `H.topology` partition contract epochs or recalled lessons) is prohibited inside the wire `system` prompt and is injected exclusively into the Turn-0 `[ROLE_AND_SCOPE_CONTEXT]` user frame and `[TOPOLOGY_SYNC]` delta frames so byte 0 of the provider KV cache never invalidates mid-run.

---

# 2. `@harness-dsl/core` Port Interfaces & Data Contracts

Peer packages integrate with `@harness-dsl/core` exclusively by implementing the following TypeScript contracts.

~~~ts
import { z } from 'zod';

// ============================================================================
// 2.1 Environment & Lazy Entity Loader Ports
// ============================================================================

export interface EnvRef {
  readonly kind: 'harness:env-ref';
  readonly key: string;
}

export interface ResolutionContext {
  readonly runId: string;
  readonly activePartitions: readonly string[];
  readonly observedEffects: readonly ToolEffect[];
}

export interface Source<T> {
  readonly kind: 'harness:source';
  readonly id: string;
  load(ctx: ResolutionContext): Promise<{
    readonly data: T;
    readonly digest: string; // SHA-256 content hash for KV-cache stability & replay verification
  }>;
}

export type MaybeSource<T> = T | Source<T>;

// ============================================================================
// 2.2 Extensible Tool Effects, Policy Guards, Tripwires & Telemetry Ports
// ============================================================================

// Domain-agnostic effect descriptor emitted by tools before/after execution
// or synthesized post-flight by CheckpointableScope.diffEffects().
// E.g. @harness-dsl/fs emits { kind: 'fs:effect', attributes: { mode: 'read' | 'write', paths: string[] } }
// E.g. @harness-dsl/stripe emits { kind: 'billing:effect', attributes: { op: 'refund', amountUsd: number } }
export interface ToolEffect {
  readonly kind: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export interface EffectMatcher {
  readonly kind: 'harness:effect-matcher';
  readonly id: string;
  matches(effect: ToolEffect): boolean;
}

export interface LeaseDelta {
  readonly kind: 'harness:lease-delta';
  readonly id: string;
  readonly grantedMatchers: readonly EffectMatcher[];
}

export interface PolicyGuard {
  readonly kind: 'harness:policy-guard';
  readonly id: string;
  evaluate(op: {
    readonly toolName: string;
    readonly proposedEffects: readonly ToolEffect[];
    readonly activeLeases: readonly LeaseDelta[];
  }): {
    readonly allowed: boolean;
    readonly violatedEffects: readonly ToolEffect[];
    readonly violationSummary: string;
  };
}

export interface QuotaTripwire {
  readonly kind: 'harness:quota-tripwire';
  readonly id: string;
  onToolEffects(
    accumulatedEffects: readonly ToolEffect[],
    newEffects: readonly ToolEffect[],
  ): {
    readonly tripped: boolean;
    readonly reason?: string;
  };
}

export interface TelemetryCollector<TMetrics extends Record<string, unknown> = Record<string, unknown>> {
  readonly kind: 'harness:telemetry-collector';
  readonly id: string;
  readonly schema: z.ZodType<TMetrics>;
  collect(effects: readonly ToolEffect[]): TMetrics;
}

export interface AbortHook<THandle = unknown, TAbortMeta extends Record<string, unknown> = Record<string, unknown>> {
  readonly kind: 'harness:abort-hook';
  readonly id: string;
  readonly metaSchema: z.ZodType<TAbortMeta>;
  execute(handle: THandle, runId: string): Promise<TAbortMeta>;
}

export interface ScopeRewindHook<THandle = unknown> {
  readonly kind: 'harness:scope-rewind-hook';
  readonly id: string;
  onRewind(handle: THandle, targetCheckpoint?: string): Promise<void>;
}

// ============================================================================
// 2.3 Executable Units, Checks, Tools & Lifecycle-Bound Services
// ============================================================================

export interface ExecutionContext<THandle = unknown> {
  readonly runId: string;
  readonly stepExecId: string;
  readonly scopeHandle: THandle;
  readonly activePartitions: readonly string[];
  readonly activeLeases: readonly LeaseDelta[];
  readonly seededHistory?: readonly WireFrameRecord[];
  readonly resumeContinuationStack?: readonly ContinuationFrame[];
  recordEffects(effects: readonly ToolEffect[]): void;
}

export interface StepExecutable<TIn = unknown, TOut = unknown, THandle = unknown> {
  readonly kind: 'harness:step-executable';
  readonly id: string;
  readonly inputSchema: z.ZodType<TIn>;
  readonly outputSchema: z.ZodType<TOut>;
  extractPartitions?(input: TIn): readonly string[];
  execute(input: TIn, ctx: ExecutionContext<THandle>): Promise<TOut>;
}

export interface Check<THandle = unknown> {
  readonly kind: 'harness:check';
  readonly id: string;
  run(ctx: {
    readonly scopeHandle: THandle;
    readonly observedEffects: readonly ToolEffect[];
  }): Promise<{
    readonly ok: boolean;
    readonly deficits: readonly string[];
  }>;
}

export interface ToolDefinition<THandle = unknown> {
  readonly kind: 'harness:tool';
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodTypeAny;
  // Static effect predictor for pure/known tools (e.g., edit_file, read_file).
  // MUST be omitted on arbitrary code-execution or subprocess tools (e.g., local.command.asTool(),
  // local.streamCheck.asTool()) so the runtime enforces CheckpointableScope post-flight diffing.
  describeEffects?(args: unknown, scopeHandle: THandle): readonly ToolEffect[];
  execute(args: unknown, ctx: ExecutionContext<THandle>): Promise<{
    readonly content: string;
    readonly isError?: boolean;
  }>;
}

export interface ServiceSession<THandle = unknown> {
  readonly id: string;
  readonly tools: readonly ToolDefinition<THandle>[];
  stop(): Promise<void>;
}

export interface Service<THandle = unknown> {
  readonly kind: 'harness:service';
  readonly id: string;
  readonly lifecycle: 'scope' | 'fork' | 'skill';
  // Static tool schemas declared up front so wire-level tool definitions never mutate mid-session
  readonly toolSchemas: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly inputSchema: z.ZodTypeAny;
  }>;
  acquire(ctx: {
    readonly runId: string;
    readonly scopeKey: string;
    readonly scopeHandle: THandle;
  }): Promise<ServiceSession<THandle>>;
}

// ============================================================================
// 2.4 Capability-Tiered Isolation Scopes & Speculative Cross-Verifier Ports
// ============================================================================

export type ReconcileResult<TData> =
  | {
      readonly status: 'clean';
      readonly data: TData;
    }
  | {
      readonly status: 'conflict';
      readonly conflictedSummary: string;
      readonly data: TData;
    };

// Tier 1 — Base Isolation Scope (Required by H.flow().scope(); sufficient for API/ERP/DB scopes)
export interface IsolationScope<
  THandle = unknown,
  TReceipt extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly kind: 'harness:isolation-scope';
  readonly id: string;
  readonly receiptSchema: z.ZodType<TReceipt>;
  acquireRoot(runId: string): Promise<THandle>;
  // Reboot recovery: rebinds an existing root scope handle from persistent state / checkpoint
  reattachRoot(runId: string, checkpoint?: string): Promise<THandle>;
  inspect(handle: THandle): Promise<TReceipt>;
  release(handle: THandle): Promise<void>;
}

// Tier 2 — Checkpointable Scope (Required when guarding tools that omit static describeEffects()
// or when using .replaceWith() without an explicit AbortHook)
export interface CheckpointableScope<
  THandle = unknown,
  TReceipt extends Record<string, unknown> = Record<string, unknown>,
> extends IsolationScope<THandle, TReceipt> {
  readonly supportsCheckpoints: true;
  // Captures the scoped uncommitted state of the handle so post-flight guard rollbacks
  // restore the exact pre-tool state without losing prior turns.
  serializeCheckpoint(handle: THandle): Promise<string>;
  restoreCheckpoint(handle: THandle, checkpoint: string): Promise<void>;
  // Synthesizes ToolEffect descriptors by deterministically diffing scope state against fromCheckpoint.
  diffEffects(fromCheckpoint: string, handle: THandle): Promise<readonly ToolEffect[]>;
}

// Tier 3 — Branchable Scope (Required when an actor uses .fork(), .speculate(),
// or .mutatePlan() with onPrerequisiteSpawned: 'suspend-and-yield-slot')
export interface BranchableScope<
  THandle = unknown,
  TReceipt extends Record<string, unknown> = Record<string, unknown>,
  TSync extends Record<string, unknown> = Record<string, unknown>,
> extends IsolationScope<THandle, TReceipt> {
  readonly supportsBranching: true;
  readonly syncSchema: z.ZodType<TSync>;
  forkChild(parent: THandle, forkId: string): Promise<THandle>;
  // Reboot recovery: rebinds an existing child scope handle (e.g. a SuspendedForkRecord worktree)
  reattachChild(parent: THandle, forkId: string, checkpoint?: string): Promise<THandle>;
  // Zero-pollution commit: if parent has advanced and conflicts with child, rebases child onto
  // parent leaving conflict state inside childHandle (never polluting parent) and returns status: 'conflict'.
  commitChild(child: THandle, parent: THandle): Promise<ReconcileResult<TReceipt>>;
  // Dirty-safe child rebase: preserves uncommitted edits in pausedChild across rebase onto parent.
  syncChild(parent: THandle, pausedChild: THandle): Promise<ReconcileResult<TSync>>;
  // Syncs a suspended parent root scope with completed prerequisite receipts upon wakeup.
  syncRoot(rootHandle: THandle, prerequisiteReceipts: readonly TReceipt[]): Promise<ReconcileResult<TSync>>;
  // Optional gate check verifying that all conflict markers in handle are resolved before stop.
  conflictCleanCheck?: Check<THandle>;
}

export interface CrossVerifier<
  THandle = unknown,
  TReceipt extends Record<string, unknown> = Record<string, unknown>,
  TCrossReport = unknown,
> {
  readonly kind: 'harness:cross-verifier';
  readonly reportSchema: z.ZodType<TCrossReport>;
  verifyCandidates(
    candidates: ReadonlyArray<{
      readonly branchIndex: number;
      readonly scopeHandle: THandle;
      readonly receipt: TReceipt;
    }>,
  ): Promise<ReadonlyArray<TCrossReport>>;
}

// ============================================================================
// 2.5 Model Driver, Unified Prefix Group & Session Forking Port
// ============================================================================

export interface CanonicalMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly visibleText: string;
  readonly toolCalls?: ReadonlyArray<{ id: string; name: string; argsJson: string }>;
  readonly toolResults?: ReadonlyArray<{ callId: string; content: string; isError: boolean }>;
}

export interface WireFrameRecord {
  readonly messageId: string;
  readonly parentMessageId: string | null;
  readonly vendorId: string;
  readonly rawWireFrame: Uint8Array;
  readonly canonical: CanonicalMessage;
  readonly prefixDigest: string;
  // Populated when completeSkill(id) is called. Never mutated in-place during same-model execution
  // (preserving 100% KV-cache hit rate and thinking signatures); substituted only by prepareFork()
  // when escalating across distinct models or cloning transcripts across actors.
  readonly compactedTombstone?: string;
}

export interface WireToolSchema {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodTypeAny;
}

export interface CompiledWirePrefix {
  readonly prefixGroupId: string;
  readonly toolsMode: 'role-scoped' | 'union';
  readonly systemPromptText: string;
  readonly systemDigest: string;
  // In 'role-scoped' mode, contains only the active actor's declared tools + skills + capabilities.
  // In 'union' mode (used for 'clone-transcript' forks), contains the deterministic union across the group.
  readonly wireToolSchemas: readonly WireToolSchema[];
}

export interface ForkContext {
  readonly historyMode: 'shared-prefix-only' | 'clone-transcript';
  readonly parentChain: readonly WireFrameRecord[];
  readonly forkPointMessageId: string | null;
  readonly wirePrefix?: CompiledWirePrefix;
  readonly childRoleContextFrameText: string;
}

export interface ModelDriver {
  readonly kind: 'harness:model-driver';
  readonly vendorId: string;
  invokeTurn(req: {
    readonly modelId: string;
    readonly accountConfig?: unknown;
    readonly effort?: 'low' | 'medium' | 'high';
    readonly wirePrefix?: CompiledWirePrefix;
    readonly history: readonly WireFrameRecord[];
    readonly tools: readonly ToolDefinition[];
    readonly outputSchema?: z.ZodTypeAny;
  }): Promise<{
    readonly wireFrame: Uint8Array;
    readonly canonical: CanonicalMessage;
    readonly structuredOutput?: unknown;
    readonly usage: {
      readonly inputTokens: number;
      readonly cachedInputTokens: number;
      readonly outputTokens: number;
      readonly costUsd: number;
    };
  }>;
  prepareFork(
    ctx: ForkContext,
    target: {
      readonly modelId: string;
      readonly accountConfig?: unknown;
      readonly effort?: 'low' | 'medium' | 'high';
      readonly substituteTombstones: boolean;
    },
  ): Promise<readonly WireFrameRecord[]>;
}

// ============================================================================
// 2.6 Storage Ports (Ledger, Continuation Stacks, Topology, Lessons)
// ============================================================================

export interface UniversalStepTelemetry<
  TCustomMetrics extends Record<string, unknown> = Record<string, unknown>,
  TAbortMeta extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly turnsTaken: number;
  readonly costUsd: number;
  readonly durationMs: number;
  readonly custom: TCustomMetrics;
  readonly abortMeta?: TAbortMeta;
}

export interface PendingPreFlightCall {
  readonly callId: string;
  readonly toolName: string;
  readonly argsJson: string;
}

// Serialized execution frame preserving composite H.loop + H.agent call stacks across both
// upward interrupt suspensions (SuspendedForkRecord) and process crash recovery (LedgerStore).
export type ContinuationFrame =
  | {
      readonly kind: 'agent-frame';
      readonly agentId: string;
      readonly stepExecId: string;
      readonly inputJson: string;
      readonly leafMessageId: string | null;
      readonly activeLeases: readonly LeaseDelta[];
      readonly pausedAtPhase: 'ACTIVE_TURN' | 'TOOL_BOUNDARY' | 'BEFORE_STOP_GATE';
      readonly pendingPreFlightCall?: PendingPreFlightCall;
    }
  | {
      readonly kind: 'loop-frame';
      readonly loopId: string;
      readonly stepExecId: string;
      readonly loopInputJson: string;
      readonly iteration: number;
      readonly phase: 'act' | 'evaluate';
      readonly preservedActLeafMessageId: string | null;
      // Loop-level lease accumulator: leases granted in Iteration k persist across Iteration k+1
      // (including across cross-model escalations and sibling-interrupt rollbacks).
      readonly grantedLoopLeases: readonly LeaseDelta[];
      // Per-loop deduplicated lesson outcome tracker: lessonId -> worst outcome observed so far
      readonly accumulatedLessonOutcomes: Readonly<Record<string, LessonOutcome>>;
    };

export interface SuspendedForkRecord {
  readonly suspendedForkId: string;
  readonly runId: string;
  readonly parentStepExecId: string;
  readonly forkToolName: string;
  readonly activePartitions: readonly string[];
  readonly suspensionReason: 'INTERRUPT_RAISED' | 'PAUSED_BY_SIBLING_INTERRUPT';
  readonly interruptId?: string;
  readonly interruptPayloadJson?: string;
  readonly suspendedAtCallId?: string;
  readonly childScopeCheckpoint?: string;
  // Ordered outer-to-inner (e.g., [loop-frame(verified-worker-loop), agent-frame(guardedWorker)])
  readonly continuationStack: readonly ContinuationFrame[];
}

export interface LedgerStore {
  readonly kind: 'harness:ledger-store';
  createOrResumeRun(run: {
    readonly runId: string;
    readonly laneId: string;
    readonly itemKey: string;
    readonly inputJson: string;
  }): Promise<{
    readonly status: string;
    readonly currentStepId: string | null;
    readonly completedStepOutputsJson: ReadonlyMap<string, string>; // stepId -> outputJson for .inputFrom() recovery
  }>;
  recordStepStart(step: {
    readonly stepExecId: string;
    readonly runId: string;
    readonly stepId: string;
    readonly inputMsgId: string | null;
    readonly baseScopeCheckpoint?: string;
    readonly continuationStack: readonly ContinuationFrame[];
  }): Promise<void>;
  updateContinuationStack(
    runId: string,
    stepExecId: string,
    continuationStack: readonly ContinuationFrame[],
  ): Promise<void>;
  appendMessageFrame(runId: string, frame: WireFrameRecord): Promise<void>;
  appendTrailingToolResultNote(runId: string, leafMessageId: string, noteText: string): Promise<void>;
  markFrameTombstone(runId: string, messageId: string, compactedTombstone: string): Promise<void>;
  getMessageChain(leafMessageId: string): Promise<readonly WireFrameRecord[]>;
  // Records a granted lease on both the active agent-frame and any enclosing loop-frame
  recordLeaseGrant(stepExecId: string, delta: LeaseDelta): Promise<void>;
  recordForkSuspension(record: SuspendedForkRecord): Promise<void>;
  getSuspendedForks(runId: string, forkIds?: readonly string[]): Promise<readonly SuspendedForkRecord[]>;
  resolveSuspendedFork(suspendedForkId: string, status: 'RESUMED' | 'ABORTED'): Promise<void>;
  recordStepTransition(transition: {
    readonly stepExecId: string;
    readonly status: 'COMPLETED' | 'INTERRUPTED' | 'FAILED' | 'SUSPENDED';
    readonly outputJson?: string;
    readonly headScopeCheckpoint?: string;
    readonly telemetryJson: string;
    readonly pendingPreFlightCall?: PendingPreFlightCall;
  }): Promise<void>;
  recordRunTerminalReceipt(runId: string, itemKey: string, scopeReceiptJson: string): Promise<void>;
  getRunTerminalReceipts(itemKeys: readonly string[]): Promise<ReadonlyMap<string, string>>;
  getInterruptedStepsOnBoot(): Promise<
    ReadonlyArray<{
      readonly runId: string;
      readonly stepExecId: string;
      readonly stepId: string;
      readonly baseScopeCheckpoint?: string;
      readonly continuationStack: readonly ContinuationFrame[];
    }>
  >;
  compactRunFrames(itemKey: string): Promise<void>;
}

export interface TopologyPartitionState {
  readonly partitionId: string;
  readonly epoch: number;
  readonly contractText: string;
  readonly updatedAt: string;
}

export interface TopologyStore {
  readonly kind: 'harness:topology-store';
  getPartitions(): Promise<ReadonlyMap<string, TopologyPartitionState>>;
  updateContract(partitionId: string, newContractText: string): Promise<{ readonly newEpoch: number }>;
}

export type LessonOutcome = 'clean_pass' | 'gate_rejected' | 'violated';

export interface DistilledLessonCandidate {
  readonly admit: boolean;
  readonly partition?: string;
  readonly directive?: string;
}

export interface LessonRecord {
  readonly id: string;
  readonly partition?: string;
  readonly directive: string;
  readonly epochAtCreation: number;
  readonly recentOutcomes: ReadonlyArray<LessonOutcome>;
  readonly totalCleanPasses: number;
  readonly totalViolated: number;
}

export interface LessonStore {
  readonly kind: 'harness:lesson-store';
  queryCandidates(req: {
    readonly queryText: string;
    readonly partitions: readonly string[];
  }): Promise<readonly LessonRecord[]>;
  admit(lesson: {
    readonly partition?: string;
    readonly directive: string;
    readonly epochAtCreation: number;
  }): Promise<string>;
  recordOutcomes(
    outcomes: ReadonlyArray<{ readonly lessonId: string; readonly outcome: LessonOutcome }>,
  ): Promise<ReadonlyArray<LessonRecord>>;
  retire(lessonIds: readonly string[]): Promise<void>;
}

// ============================================================================
// 2.7 External Tracker, Stream, Human & Control-Plane Ports
// ============================================================================

export interface TrackerAdapter<TExternal, TExternalState extends string = string> {
  readonly kind: 'harness:tracker-adapter';
  poll(): Promise<readonly TExternal[]>;
  setExternalState(itemKey: string, state: TExternalState): Promise<void>;
}

export interface StreamSource<TEvent> {
  readonly kind: 'harness:stream-source';
  subscribe(onEvent: (event: TEvent) => Promise<void>): Promise<{ close(): Promise<void> }>;
}

export interface HumanAdapter {
  readonly kind: 'harness:human-adapter';
  notify(message: string): Promise<void>;
  requestDecision<TRequest, TResponse>(req: {
    readonly runId: string;
    readonly humanId: string;
    readonly payload: TRequest;
    readonly responseSchema: z.ZodType<TResponse>;
    readonly keepAliveSeconds?: number;
  }): Promise<TResponse>;
}

export interface ControlPlaneAdapter {
  readonly kind: 'harness:control-plane-adapter';
  start(runtime: HarnessRuntimeController): Promise<{ close(): Promise<void> }>;
}

export interface HarnessRuntimeController {
  emitSignal<TPayload>(signalId: string, payload: TPayload): Promise<void>;
  getActiveRuns(): Promise<ReadonlyArray<{ runId: string; laneId: string; itemKey: string; status: string }>>;
}
~~~

---

# 3. `@harness-dsl/core` Primitives & Orchestration Semantics

## 3.1 Signals (`H.signal`), Interrupts (`H.interrupt`) & Event Streams (`H.stream`)

* **`H.signal(id).payload(zodSchema)`:** Asynchronous event emitted by external streams, control-plane adapters, or internal threshold monitors. Signals route to active runs or ledger compaction hooks without unwinding execution call stacks.
* **`H.interrupt(id).payload(zodSchema)`:** Synchronous upward exception raised voluntarily by an `H.agent` (via a structured interrupt tool call) or deterministically by an `H.policy` guard/tripwire. Raising an interrupt halts the active step and transfers control to the nearest enclosing `.onInterrupt()` or `.onChildInterrupt()` edge.
* **`H.stream(id).source(streamSource).filter(pred).emitSignal(signal, mapper)`:** Binds a `StreamSource<TEvent>` adapter, filters incoming events synchronously, and emits correlated `H.signal` instances into the harness runtime.

## 3.2 Capacity Pools (`H.pool`), Unified Warm-Fork Prefixes (`H.prefixGroup`) & Deterministic Fork Routing

`H.pool` schedules concurrent access across account seats or models:

* **Account Pools:** Multiplex across subscription seats (`strategy: 'soonest-reset' | 'round-robin' | 'least-used'`) and cascade to `.fallback(account)` when all primary seats are rate-limited.
* **Model Pools:** Track empirical completion rates per model in the ledger and escalate along the pool chain via `.strategy(($) => $.escalateOnRetry().minSuccessRate(r).minSamples(n))`.

### 3.2.1 Run-Immutable Unified Warm-Fork Prefix Groups (`H.prefixGroup`)

Provider KV caches (Anthropic and OpenAI) key their prefix caches on `(model_id, wire_tools_array, system_prompt, messages[0..k])` across all requests within the cache TTL.

~~~ts
export const engineeringPrefix = H.prefixGroup('engineering-prefix')
  .toolsMode('role-scoped') // Default: 'role-scoped'; optional 'union' for 'clone-transcript' forks
  .sharedGrounding(
    fs.text('PRODUCT_SPEC.md'),
    fs.text('TECH_DESIGN.md'),
  )
  .sharedInstructions(fs.text('.harness/prompts/base-posture.md'))
  .sharedRules(repoRules);
~~~

* **Run-Immutable Wire `system` Field:** For every `H.agent` bound to `.prefixGroup(engineeringPrefix)`, the top-level wire `system` prompt contains *only* the group's `.sharedGrounding(...)`, `.sharedInstructions(...)`, and global rules from `.sharedRules(...)`, ordered deterministically by `Source.digest`. Mutable runtime state (such as `H.topology` contract epochs) is strictly excluded from `.sharedGrounding()` so in-run contract updates never invalidate the wire `system` digest.
* **Two Wire Tool Modes (`.toolsMode('role-scoped' | 'union')`):**
    * **`'role-scoped'` (Default, paired with `historyMode: 'shared-prefix-only'`):** Each actor transmits only its own declared `.tools()`, `.skills()` tool schemas, and `.capabilities()` tools alongside the shared `systemPromptText`. Because `'shared-prefix-only'` forks start a clean transcript at `messages[0]` and provider caches are content-addressed per `(model_id, tools, system)`, every `sonnet` worker achieves a 100% prefix cache hit across all `sonnet` worker invocations without paying token prefill overhead for—or being tempted to call—`coordinator`-only orchestration tools (`delegate-partition`, `explore-candidates`, `spawnTasks`, `resumeFork`).
    * **`'union'` (Required only when a member actor configures `.fork(..., $f => $f.historyMode('clone-transcript'))` across distinct roles):** At AST compilation time, `@harness-dsl/core` computes the deterministic union of tool schemas across all member actors in the `prefixGroup` so a child fork cloning the parent's `messages[0..k]` transcript retains byte-identical `tools` and `system` blocks prior to `messages[0]`. Out-of-role tools are marked `[Requires active role/skill lease]` and blocked pre-flight by the runtime role lease gate.
* **Turn-0 `[ROLE_AND_SCOPE_CONTEXT]` Frame:** Actor-specific `.instructions(...)` (such as `coordinator.md` vs `worker.md`), live `H.topology` partition contracts and epochs, partition-scoped rules, and recalled lessons are never placed in the wire `system` field. Instead, they are injected into the structured `[ROLE_AND_SCOPE_CONTEXT]` user message frame at Turn 0 of the session (`historyMode: 'shared-prefix-only'`) or at the transcript fork point (`historyMode: 'clone-transcript'`).

### 3.2.2 Deterministic Downward Fork Model Routing

Configuring `.modelRouting(($m) => $m.inheritParentWithEffort('medium', { when: (parentInput, toolReq) => boolean }).otherwisePool(pool))` on `.fork()` evaluates the deterministic `when` predicate over `(parentInput, toolReq)` (for example, `req.estimatedTurns <= 6`) to keep short forks on the parent model's weights with reduced reasoning effort while routing longer forks to `pool`.

## 3.3 Relational System Topology (`H.topology`)

`H.topology(id).store(topologyStore).partitions(record)` defines the directed graph of logical system partitions.

* **Pure Relational Graph:** Each partition key declares optional `dependsOn: readonly string[]` edges. Core `H.topology` has zero awareness of files or globs; domain packages (such as `@harness-dsl/fs`) map partitions to physical resources externally.
* **Versioned Contract Epochs & Turn-0 Injection:** The `TopologyStore` tracks an integer `epoch` and `contractText` per partition. When an actor binds `.topology(repoTopology)`, the runtime injects the live partition graph, contract texts, and epoch numbers into that actor's Turn-0 `[ROLE_AND_SCOPE_CONTEXT]` frame (and injects `[TOPOLOGY_SYNC]` deltas on `resumeFork`), keeping the `H.prefixGroup` wire `system` prompt completely immutable when contracts advance from Epoch $E$ to $E+1$.
* **Graph Queries:**
    * `topology.dependentsOf(partitionId)` returns all strict transitive dependent partition IDs (e.g., `dependentsOf('db') -> ['api', 'web']`).
    * `topology.affectedBy(partitionId)` returns `[partitionId, ...topology.dependentsOf(partitionId)]` (e.g., `affectedBy('db') -> ['db', 'api', 'web']`), ensuring both the target partition itself and all its transitive dependents are paused when a contract violation targets `partitionId`.

## 3.4 Contextual Knowledge (`H.rules`, `H.skill`, `H.lessons`)

### 3.4.1 Rules (`H.rules`)

Consumes inline rule objects or `Source` adapters (`GlobalRuleSchema`, `ScopedRuleSchema`).

* **`.global(...MaybeSource<GlobalRule | GlobalRule[]>[])`:** Resolved at session start and pinned in the static system prompt prefix (or `H.prefixGroup`).
* **`.scoped(...MaybeSource<ScopedRule | ScopedRule[]>[])`:** Bound to `.when({ partitions?: string[], effects?: EffectMatcher })` and optional `.enforceBeforeStop(...Check[])`:
    * **Pre-Flight Injection:** Injected into the initial `[ROLE_AND_SCOPE_CONTEXT]` frame if the task's `activePartitions` (extracted via `.partitions()`) intersect `when.partitions`.
    * **Reactive Effect Injection:** Injected into the `tool_result` frame the first time an agent invokes a tool whose `ToolEffect` matches `when.effects`.
    * **Gate Enforcement:** Runs attached `Check` instances during the actor's `beforeStop` gate if matching effects occurred during the session.

~~~ts
export const ScopePredicateSchema = z.object({
  partitions: z.array(z.string()).default([]),
  effects: z.custom<EffectMatcher>().optional(),
});

export const GlobalRuleSchema = z.object({
  id: z.string(),
  directive: z.string().min(1),
});

export const ScopedRuleSchema = z.object({
  id: z.string(),
  when: ScopePredicateSchema,
  directive: z.string().min(1),
  checks: z.array(z.custom<Check>()).default([]),
});
~~~

### 3.4.2 Skills (`H.skill`) & Zero-Invalidation KV-Cache Protocol

Encapsulates on-demand procedural instructions, tools, and services without busting the LLM provider's prompt prefix cache or invalidating cryptographic thinking signatures:

* **Static Wire Tool Registration with Lease Gating:** When an `H.agent` is initialized with `.skills(...)`, all tool schemas from `.unlocksTools(...ToolDefinition[])` and `.unlocksServices(...Service[])` (`Service.toolSchemas`) are registered in that actor's wire-level `tools` array from Turn 0 with `[Requires active skill: <id>]` appended to their description. The wire `tools` array never mutates mid-session. If an agent invokes a skill-gated tool while the skill is inactive, the runtime blocks the call pre-flight and returns an `isError: true` tool result instructing the agent to call `activateSkill(id)` first.
* **Skill Activation (`activateSkill(id)`):** Resolves instructions (`MaybeSource<string>`), acquires all `.unlocksServices(...Service[])` sessions for the active `scopeHandle`, grants an execution lease for the skill's tools, and returns the skill instructions in the `tool_result` frame.
* **Skill Completion (`completeSkill(id)`) & Cross-Model Tombstone Substitution:** Under `.lease('until-completed-or-fork-exit')`, calling `completeSkill(id)`:
    * Immediately stops and unmounts all acquired `ServiceSession` instances (freeing OS processes and ports) and revokes the active execution lease for the skill's tools.
    * Calls `LedgerStore.markFrameTombstone(runId, activateMsgId, "[Skill '<id>' completed and unmounted]")` on the earlier `activateSkill` `WireFrameRecord`.
    * **Same-Model Preservation:** Throughout the active session (and across same-model preserved-session `H.loop` iterations), `rawWireFrame` is transmitted untouched (`substituteTombstones: false`) so the provider's KV prefix cache remains 100% intact and all subsequent `thinking` / encrypted reasoning blocks retain valid cryptographic signatures.
    * **Cross-Model / Transcript-Clone Substitution:** Whenever `ModelDriver.prepareFork()` synthesizes a message chain for a cross-model escalation (`M_1 != M_2`, where provider KV caches and signatures do not transfer) or a `clone-transcript` fork (`substituteTombstones: true`), it substitutes `compactedTombstone` in place of the bulky instruction payload.

### 3.4.3 Lessons (`H.lessons`) & Deduplicated Per-Execution Attribution

Backed by any `LessonStore` adapter. Because high-leverage preventative lessons (negative constraints such as *"Never use X because of Y"*) are obeyed silently across multi-turn sessions, `@harness-dsl/core` uses objective execution evidence (`clean_pass`, `gate_rejected`, `violated`) rather than worker self-citation:

* **Typed Query Extraction (`.queryFrom(inputSchema, (input) => queryText)`):** Extracts a deterministic search query string from the actor's validated input `TIn` (falling back to `JSON.stringify(input)` if omitted) and passes `{ queryText, partitions: ctx.activePartitions }` to `LessonStore.queryCandidates()`.
* **Contrastive Distillation with Noise Filtering (`.onLoopRecovery()` & `.onGateRecovery({ minFailedChecks?: number })`):**
    * **Outer Loop Recovery (`.onLoopRecovery()`):** Triggered when Iteration $k$ of an `H.loop` fails evaluation and Iteration $k + n$ ($n \ge 1$) succeeds. The distiller agent receives `{ source: 'loop', rejected: { output, scopeReceipt, deficits }, accepted: { output, scopeReceipt } }`.
    * **In-Session Gate Recovery (`.onGateRecovery()`):** Triggered asynchronously (off the critical execution path) when an `H.agent` fails `beforeStop` checks on completion attempt $a$ (with at least `minFailedChecks`, default 1) and subsequently passes all `beforeStop` checks on attempt $a + m$ ($m \ge 1$) within the same session.
    * **Non-Generalizable Noise Filter (`admit: boolean`):** The distiller agent's structured output conforms to `DistilledLessonCandidate` (`{ admit: boolean, partition?: string, directive?: string }`). If a `beforeStop` or loop failure was caused by a one-off typo or transient mistake rather than a reusable architectural invariant, the distiller returns `{ admit: false }` and no lesson is written to `LessonStore`.
* **Deduplicated Per-Execution Outcome Attribution (`1 outcome per (stepExecId, lessonId)`):**
    * To prevent a multi-iteration `H.loop` on a single pathological task from recording multiple violations for the same lesson and prematurely retiring it, lesson outcomes are accumulated in `ContinuationFrame.accumulatedLessonOutcomes` across the lifetime of the top-level `H.loop` (or standalone `H.agent`) and flushed **once** to `LessonStore.recordOutcomes()` when the step reaches a terminal transition, governed by the strict precedence order:

$$\texttt{violated} \succ \texttt{gate\_rejected} \succ \texttt{clean\_pass}$$

* **Active Evaluator Violation (`'violated'`):** When an `H.loop` is configured with `.distillLessonsInto(lessons)`, the runtime injects the active recalled lesson list into the `.evaluate()` actor's context and augments the evaluator's wire output schema with `_harnessMeta: { violatedLessonIds: string[] }` (stripped before returning the domain evaluation output). If a recalled lesson is listed in `violatedLessonIds` on *any* rejected iteration of the loop (or if the loop exhausts `maxIterations` after a violation), that lesson's terminal outcome for the loop execution is `'violated'` (counted once).
* **Friction Without Violation (`'gate_rejected'`):** Any injected lesson that never recorded `'violated'` during a session that experienced at least one `beforeStop` check failure or `H.loop` evaluation rejection (including sessions that exhaust `maxIterations` without an explicit lesson violation) records a single `'gate_rejected'` outcome. (If a step aborts via a fast-path `scopeTripwire` or `contractViolation` *before* the worker ever attempts `beforeStop` completion, zero lesson outcomes are recorded for that aborted reconnaissance attempt.)
* **Silent Preventative Success (`'clean_pass'`):** Whenever an actor session passes all `beforeStop` checks on its first completion attempt (attempt 0) and (if inside an `H.loop`) is accepted by the evaluator on Iteration 0 with zero violations, all lessons injected into that session record a single `'clean_pass'` outcome.
* **Scoring Formula:** Given query $Q$, active partitions $P$, current partition epoch $E_{\text{now}}$, creation epoch $E_0$, and sliding window $W$ of the last $K$ deduplicated step executions ($c_W$ `clean_pass`, $g_W$ `gate_rejected`, $v_W$ `violated`, where $c_W + g_W + v_W = |W| \le K$):

$$\text{Score}(L, Q) = R(L, Q) \cdot (1 + \beta \cdot \mathbb{I}(L.\text{partition} \in P)) \cdot \gamma^{(E_{\text{now}} - E_0)} \cdot \left(\frac{c_W + 1}{c_W + 2v_W + 0.5g_W + 2}\right)$$

where $\beta$ is `partitionMatchBoost` and $\gamma \in (0, 1]$ is `decayOnPartitionEpochChange`.

* **Retirement & Promotion Signals:**
    * `.retireAfter(($r) => $r.maxViolations(v).orMinCleanPassRate(minRate, { afterInjections: m }))` retires any lesson that accumulates $v$ deduplicated task violations or whose sliding-window clean-pass rate $c_W / |W|$ falls below `minRate` after at least $m$ injections.
    * `.emitSignalWhen(signal, ($t) => $t.minCleanPasses(c).maxViolations(v).cooldownHours(h))` emits `signal` so high-leverage empirical lessons can be promoted into permanent `H.rules` or deterministic `H.check` gates.

## 3.5 Capability Policies (`H.policy`), Deterministic Post-Flight Scope Diffing & Suspended Tool Replay

`H.policy(id)` enforces deterministic sandbox guards, default abort hooks (`.onAbort(abortHook)`), and quantitative tripwires over an `H.agent`:

* **Two-Phase Effect Guard Enforcement (`.guard(...PolicyGuard[]).onViolation('raise-interrupt', interrupt)`):**
    * **Pre-Flight Check & Suspended Tool Call Capture:** If `tool.describeEffects(args, scopeHandle)` is defined, the runtime evaluates `PolicyGuard.evaluate()` prior to invoking `tool.execute()` against the union of the active `agent-frame.activeLeases` and any enclosing `loop-frame.grantedLoopLeases`. On violation, the tool call is blocked with zero side effects, recorded in the ledger as `pendingPreFlightCall = { callId, toolName, argsJson }`, and `interrupt` is raised immediately.
    * **Suspended Pre-Flight Tool Replay on Lease Elevation:** When an interrupt raised by a pre-flight `PolicyGuard` is adjudicated via `.onInterrupt()` and resumes via `.resumeWith(feedback)`:
        * If `.elevateLeaseWhen()` granted a `LeaseDelta`, the runtime records the lease on both the active `agent-frame` and any enclosing `loop-frame` (`LedgerStore.recordLeaseGrant`) and re-evaluates `PolicyGuard.evaluate()` for `pendingPreFlightCall`.
        * If now `allowed: true`, the runtime **executes `tool.execute(args, ctx)` immediately** without requiring the LLM to regenerate the tool call, clears `pendingPreFlightCall`, and appends `[Lease Elevated: ${feedback}]\n\n${toolResult.content}` as the `tool_result` frame.
        * If still disallowed (no lease granted or insufficient lease), the runtime clears `pendingPreFlightCall` and appends `[Lease Denied: ${feedback}]` with `isError: true` as the `tool_result` frame.
    * **Mandatory Post-Flight Check & Scope-Diff Rollback for Code-Executing / Subprocess Tools (Requires `CheckpointableScope`):** Any tool that executes arbitrary code or subprocesses inside the workspace (such as `local.command.asTool()` or `local.streamCheck.asTool()`, including `verifySuite.asTool()`) MUST omit `describeEffects`. If an actor mounts any tool that omits `describeEffects` under an active `PolicyGuard`, the AST compiler verifies that the enclosing flow's `IsolationScope` implements `CheckpointableScope`. Before invoking the tool, the runtime snapshots the scoped uncommitted state via `const preToolCkpt = await scope.serializeCheckpoint(scopeHandle)`. Immediately after `tool.execute()` completes, the runtime calls `const synthesizedEffects = await scope.diffEffects(preToolCkpt, scopeHandle)`, merges `synthesizedEffects` into `ctx.recordEffects()`, and evaluates `PolicyGuard.evaluate()`. If the subprocess or test run mutated any protected path (for example, a newly created test file attempting to write to `packages/db/src/index.ts` or an existing `*.test.ts` file during `verifySuite.asTool()`), the runtime calls `await scope.restoreCheckpoint(scopeHandle, preToolCkpt)` to roll back the unauthorized delta and raises `interrupt`.
* **Quantitative Tripwires:**
    * Universal LLM loop tripwires: `.maxTurns(n)`, `.maxCostUsd(n)`, `.maxDurationSeconds(n)`.
    * Domain quota tripwires: `.tripwire(...QuotaTripwire[])` (e.g., `fs.maxFilesMutated(4)` from `@harness-dsl/fs`) evaluated post-flight after each tool execution (including synthesized `diffEffects`).
* **Limit Exceeded State-Machine Sequence (`.onLimitExceeded($l => ...)`):** When any turn, cost, duration, or `QuotaTripwire` threshold is breached, the runtime executes the following sequence in strict order:
    1. **Append Tool Result:** The breaching tool call's result frame is appended to the session history so the transcript remains valid.
    2. **Epistemic Flush (`.flushWithInterrupt(interrupt)`):** While the `scopeHandle` is still intact, the runtime gates all external tools and invokes a single final turn (`maxTurns: 1`) constrained to `interrupt.schema`.
    3. **Scope Abort Hook (`.onAbort(abortHook)`):** After the flush turn completes, the runtime executes `const abortMeta = await abortHook.execute(scopeHandle, runId)` (or the policy-level `.onAbort(abortHook)` if configured) and attaches `abortMeta` to `stepTelemetry.abortMeta`.
    4. **Interrupt Routing:** The runtime transitions the step to `INTERRUPTED` and transfers control to the enclosing `.onInterrupt(interrupt)` handler with `(flowInput, intrPayload, stepTelemetry)`.

## 3.6 Humans (`H.human`)

`H.human(id).keepAliveSeconds(n).notify(humanAdapter)` represents an external human decision authority invoked declaratively via `.ask(human, responseSchema)` or `.escalate()`.

## 3.7 Universal Actor (`H.agent`), `.partitions()`, `beforeStop` Gates & Hierarchical Capabilities

`H.agent(id)` is the single LLM actor primitive in `@harness-dsl/core`, implementing `StepExecutable<TIn, TOut, THandle>`.

### 3.7.1 Prefix Groups, `.partitions()`, Grounding, Instructions, `beforeStop` Gates & Clones

* **`.prefixGroup(group)`:** Joins a compiled `H.prefixGroup` so actors share a byte-identical wire `system` prompt (and, when `toolsMode: 'union'` is configured, `unionToolSchemas`).
* **`.partitions((input: TIn) => readonly string[])`:** Pure synchronous extractor mapping the actor's validated input `TIn` to `ResolutionContext.activePartitions` (driving scoped rule injection, lesson candidate queries, and sibling partition pause matching).
* **`.topology(topology)`:** Injects live partition contracts and epoch numbers into the Turn-0 `[ROLE_AND_SCOPE_CONTEXT]` user frame (never into the static wire `system` prompt).
* **`.grounding(...MaybeSource<string>[])` & `.instructions(...MaybeSource<string>[])`:** Resolved at session start and hashed by `Source.digest`. When `.prefixGroup()` is bound, actor-specific `.instructions()` are placed in the Turn-0 `[ROLE_AND_SCOPE_CONTEXT]` user frame so the top-level wire `system` field stays invariant.
* **`.beforeStop(...Check<THandle>[])`:** When the agent emits its final structured output turn, the harness intercepts completion and runs all attached `Check` instances, any `enforceBeforeStop` checks from triggered scoped rules, and `BranchableScope.conflictCleanCheck` (whenever a prior `syncChild` or `syncRoot` reported `status: 'conflict'`). If any check fails, the deficits are appended to the session as a gate-rejection user turn (triggering `.onGateRecovery()` snapshot capture if bound to `.lessons()`) and the agent continues iterating in-session until all gates pass.
* **Actor-Level Default Interrupt Handlers (`.onInterrupt(interrupt, $intr => ...)`):**
    * **Scoped Input Parameter (`actorInput: TIn`):** An `H.agent<TIn, TOut, THandle>` may bind default `.onInterrupt()` adjudication and lease-elevation handlers directly on the actor definition. In an actor-level handler, the first parameter passed to `.adjudicateWith((actorInput, intrPayload) => ...)` and `.replaceWith((actorInput, intrPayload, stepTelemetry) => ...)` is `actorInput: TIn`. Actor-level interrupt handlers execute automatically unless overridden by a step-level `.onInterrupt()` handler for the same interrupt.
    * **Handler & Partition Preservation on `.withPolicy()` and `.withTools()`:** Calling `agent.withPolicy(newPolicy)` or `agent.withTools(...extraTools)` returns a derived `H.agent` clone that updates the policy mask or appends `extraTools` to the actor's toolset while preserving `.prefixGroup()`, `.partitions()`, `.topology()`, all actor-level `.onInterrupt()` handlers, existing tools, skills, rules, lessons, and `beforeStop` checks bound on the base agent.

### 3.7.2 Hierarchical Capabilities (`.capabilities($cap => ...)`) & Per-Handle Scope Locks

Capabilities that branch scope handles (`.fork()`, `.speculate()`, and `.mutatePlan()` with `suspend-and-yield-slot`) require the enclosing flow's `IsolationScope` to implement `BranchableScope`. To prevent concurrent child forks from racing on a shared `parentHandle`, `@harness-dsl/core` maintains an asynchronous Read/Write lock per `scopeHandle` (`ScopeLockManager`). Any operation that reads or mutates `parentHandle` (`forkChild`, `commitChild`, `syncChild`, and parent tool executions) acquires an **exclusive write lock** on `parentHandle`. Child forks execute concurrently against their own isolated `childHandle` without holding locks on `parentHandle`.

**Capability 1 — Downward Forking (`.fork(toolName, childExecutable, $f => ...)`):**

* Exposes a tool call validated by `.requestSchema(zod)` and projected to the child's input via `.mapInput((parentInput, toolReq) => childInput)`.
* **History Mode (`.historyMode('shared-prefix-only' | 'clone-transcript')`, default `'shared-prefix-only'`):**
    * Under `'shared-prefix-only'` (default), the child actor shares the compiled `H.prefixGroup` `systemPromptText` alongside its own role-scoped wire `tools` array (`toolsMode: 'role-scoped'`) and starts at `messages[0]` with its own clean `[ROLE_AND_SCOPE_CONTEXT]` + mapped task prompt—preventing parent transcript noise, parent orchestration tool schemas, or parent mid-session skill tombstones from polluting the child.
    * Under `'clone-transcript'` (which requires `H.prefixGroup.toolsMode('union')` if parent and child have different toolsets), `ModelDriver.prepareFork()` clones `parentChain` up to `forkPointMessageId` and appends the child's `[ROLE_AND_SCOPE_CONTEXT]` frame.
* Acquires a brief write lock on `parentHandle` to fork a child scope handle (`BranchableScope.forkChild`) and executes `childExecutable` inside `childHandle` while persisting the live `ContinuationFrame[]` stack (`loop-frame` -> `agent-frame`) via `LedgerStore.updateContinuationStack`.
* **Zero-Pollution Conflict-Bounce Reconciliation:** Upon child completion, the runtime acquires the exclusive write lock on `parentHandle` and invokes `const res = await scope.commitChild(childHandle, parentHandle)`:
    * If `res.status === 'clean'`, the runtime releases the lock, calls `scope.release(childHandle)`, and returns `{ status: 'COMPLETED', output: childOutput, scopeReceipt: res.data }` as the `tool_result` to the parent, discarding all intermediate child turns from the parent's context window.
    * If `res.status === 'conflict'` (because `parentHandle` advanced while the child was running), `commitChild` leaves `parentHandle` untouched and places the rebased conflict state inside `childHandle`. The runtime releases the lock on `parentHandle`, appends a `[COMMIT_CONFLICT]` turn (`res.conflictedSummary`) to the child's inner actor session, re-runs the child (including `conflictCleanCheck`, all `beforeStop` checks, and any enclosing `H.loop` evaluator step), and re-attempts `commitChild` (up to 2 conflict-repair retries before failing the fork).

**Capability 2 — Speculative Execution Tournament (`.speculate(toolName, $s => ...)`) with Non-Destructive Contested Escalation Arbitration:**

* Exposes a tool call validated by `.requestSchema(zod)`.
* Forks $B$ parallel child scope handles (`BranchableScope.forkChild`) and executes `.worker(actorOrLoop)` across the $B$ inputs mapped by `.branches(B, (parentInput, toolReq) => [input0, input1, ...])`.
* **Exogenous Escalation Parking Barrier (`H.human` Suppression During Branch Execution):**
    * While executing inside a speculative branch, endogenous interrupt adjudications (such as `guardedWorker` raising `leaseRequest` to the read-only `leaseAdjudicator` LLM) execute immediately in-branch.
    * If any branch attempts to cross an **exogenous human boundary** (invoking `.ask(human, ...)` or `.escalate(...)` to an `H.human` authority, either directly or via a nested adjudicator raising `normativeEscalation`), the tournament supervisor **intercepts and parks** that branch (`status: 'PARKED_ON_EXOGENOUS_ESCALATION'`) without paging the human, capturing its partial `scopeReceipt` (`scope.inspect(childHandle)`) and the structured escalation payload while keeping its `childHandle` and `ContinuationFrame[]` stack intact.
* **Post-Race Resolution & Non-Destructive Contested Escalation Protection:** Once all $B$ branches reach `COMPLETED`, `FAILED`, or `PARKED_ON_EXOGENOUS_ESCALATION`:
    * **Case 1 — Zero Surviving or Parked Branches (`0 COMPLETED`, `0 PARKED`):** Releases all child handles and propagates an aggregate branch execution error.
    * **Case 2 — All Non-Failed Branches Parked on Exogenous Escalation (`0 COMPLETED`, $\ge 1$ `PARKED`):** Unparks the parked branch(es), awaits the human owner's decision, resumes execution until each unparked branch reaches `COMPLETED` or `FAILED`, and re-enters post-race resolution.
    * **Case 3 — Uncontested Single Survivor (`1 COMPLETED`, `0 PARKED`, remaining branches `FAILED` on endogenous errors):** Short-circuits `.crossVerifyWith()` and `.arbiter()`. If `.verifyWinnerWith(evaluator, opts)` is configured on `.speculate()`, the runtime runs `evaluator` once on the sole survivor before committing; otherwise it commits `soleWinnerHandle` directly into `parentHandle` via `commitChild`, releases losing handles, and returns `{ output: soleWinnerOutput, scopeReceipt, shortCircuited: true }`.
    * **Case 4 — Multiple Completed Survivors OR Contested Escalation ($\ge 2$ `COMPLETED`, OR $\ge 1$ `COMPLETED` alongside $\ge 1$ `PARKED_ON_EXOGENOUS_ESCALATION`):**
        * The tournament **NEVER short-circuits arbitration when a sibling branch is parked on an exogenous escalation**, preventing a branch that quietly hacked around a spec/test contradiction from automatically silencing a sibling branch that legitimately flagged the contradiction.
        * The runtime inspects all `COMPLETED` and `PARKED_ON_EXOGENOUS_ESCALATION` branches, runs `.crossVerifyWith(crossVerifier)` across the `COMPLETED` candidates, and invokes `.arbiter(arbiterAgent, { resolveDecision: (verdict) => ... })` with input matching `H.SpeculationInputSchema`:

~~~ts
export const SpeculationCandidateSchema = <
  TIn extends z.ZodTypeAny,
  TOut extends z.ZodTypeAny,
  TReceipt extends z.ZodTypeAny,
  TCross extends z.ZodTypeAny,
  TEscPayload extends z.ZodTypeAny = z.ZodTypeAny,
>(
  inSchema: TIn,
  outSchema: TOut,
  receiptSchema: TReceipt,
  crossSchema: TCross,
  escalationSchema?: TEscPayload,
) =>
  z.discriminatedUnion('status', [
    z.object({
      status: z.literal('COMPLETED'),
      branchIndex: z.number(),
      input: inSchema,
      output: outSchema,
      scopeReceipt: receiptSchema,
      crossVerifyReport: crossSchema.optional(),
    }),
    z.object({
      status: z.literal('PARKED_ON_EXOGENOUS_ESCALATION'),
      branchIndex: z.number(),
      input: inSchema,
      scopeReceipt: receiptSchema,
      interruptId: z.string(),
      escalationPayload: escalationSchema ?? z.unknown(),
    }),
  ]);

export const SpeculationInputSchema = <
  TIn extends z.ZodTypeAny,
  TOut extends z.ZodTypeAny,
  TReceipt extends z.ZodTypeAny,
  TCross extends z.ZodTypeAny,
  TEscPayload extends z.ZodTypeAny = z.ZodTypeAny,
>(
  inSchema: TIn,
  outSchema: TOut,
  receiptSchema: TReceipt,
  crossSchema: TCross,
  escalationSchema?: TEscPayload,
) =>
  z.object({
    candidates: z.array(
      SpeculationCandidateSchema(inSchema, outSchema, receiptSchema, crossSchema, escalationSchema),
    ),
    humanRulingsHistory: z
      .array(
        z.object({
          branchIndex: z.number(),
          interruptId: z.string(),
          rulingSummary: z.string(),
        }),
      )
      .default([]),
  });
~~~

* **Arbiter Verdict Resolution (`select-winner` vs `unpark-escalation`):**
    * **`decision: 'select-winner'`:** The arbiter selects one of the `COMPLETED` branches (`winnerBranchIndex`). All parked and losing branches are aborted and their `childHandle`s released without paging the human. If `.refineWinnerWhen(pred, refinementExecutable, mapper)` matches the verdict, `refinementExecutable` runs on the winning handle before `commitChild` reconciles it into `parentHandle`.
    * **`decision: 'unpark-escalation'` (Non-Destructive Unparking):** If the arbiter determines that a parked branch identified a genuine normative question that must be answered by the human owner before choosing a winner:
        1. The runtime **retains all already-`COMPLETED` sibling branch handles alive in memory/disk** (never discarding a working candidate prematurely in case the human rules in favor of existing behavior or the unparked branch subsequently fails).
        2. The runtime unparks `parkedBranchIndex`, forwards its escalation request to the `H.human` authority, records the ruling in `humanRulingsHistory`, and resumes `parkedBranchIndex` until it transitions to `COMPLETED` or `FAILED`.
        3. The tournament then re-runs `.crossVerifyWith()` and `.arbiter()` over the updated candidate set (now including the human's ruling in `humanRulingsHistory`) to select the final winner (`decision: 'select-winner'`).

**Capability 3 — Dynamic Plan Mutation (`.mutatePlan($m => ...)`) with Prerequisite Priority Boost:**

* `.canSpawnTasks(itemSchema, { maxSpawnedPerRun, enforcePatch, onPrerequisiteSpawned: 'suspend-and-yield-slot' | 'wait-in-place', priorityStrategy?: 'inherit-parent-with-boost' | 'normal', resumeWhen?: 'prerequisite-exit' | { signal: Signal<TPayload>; correlateBy: (sig: TPayload) => string } })`: Mounts a `spawnTasks` tool that enqueues new independent work items into the enclosing `H.lane`.
    * **Head-of-Line Prerequisite Priority Inheritance (`priorityStrategy: 'inherit-parent-with-boost'`, default):** When an active run spawns a prerequisite task and suspends via `'suspend-and-yield-slot'`, the spawned prerequisite automatically inherits the parent's effective aged priority plus a prerequisite head-of-line boost so it schedules ahead of unstarted external tracker tickets at the same priority tier.
    * When the prerequisite satisfies `resumeWhen` (defaulting to `'prerequisite-exit'`), the runtime loads the prerequisite run's terminal `TReceipt` via `LedgerStore.getRunTerminalReceipts`, invokes `BranchableScope.syncRoot(parentRootHandle, prereqReceipts)`, appends a `[PREREQUISITE_SYNC]` (or `[PREREQUISITE_SYNC_CONFLICT]` if `status === 'conflict'`) note to the `spawnTasks` `tool_result` frame with the returned `TSync` payload, and re-acquires a concurrency slot to resume the parent.
* `.canAddDependencies()`: Mounts an `addDependencies` tool to insert directed edges in the active lane.
* `.canUpdateTopologyContracts(topology)`: Mounts an `updatePartitionContract` tool that updates `TopologyStore` and increments the partition's epoch.

**Capability 4 — Exogenous Escalation with Lease Elevation (`.escalate(interrupt, $esc => ...)`):**

* Exposes an escalation tool call to the agent. When invoked, requests a decision from `.to(human)` validated against `.response(zodSchema)`.
* Supports `.elevateLeaseWhen((decision) => boolean, (decision) => LeaseDelta)` to grant the calling agent a capability lease when the human authority approves mutating a protected resource.

**Capability 5 — Upward Child Interrupt Handling via Continuation-Stack Suspension & Native `resumeFork` (`.onChildInterrupt(interrupt, $intr => ...)`):**

LLM wire protocols require every `tool_use` block in an assistant turn to resolve to a `tool_result` block before the parent agent can take its next turn. `@harness-dsl/core` resolves upward child interrupts on the single parent timeline via Continuation-Stack Suspend-and-Return:

~~~ts
.onChildInterrupt(contractViolation, ($intr) =>
  $intr
    .pauseSiblingForksInPartitions((v) => repoTopology.affectedBy(v.partition))
    .suspendAndReturnToParent(),
)
~~~

* **Child Continuation-Stack Suspension & State-Aware Sibling Pause:**
    * When a downward child fork raises `interrupt` (e.g., `contractViolation` targeting partition `'db'`), the runtime serializes its full `ContinuationFrame[]` stack (preserving any outer `loop-frame` such as `verifiedWorkerLoop` alongside the inner `agent-frame` of `guardedWorker`) into `LedgerStore.recordForkSuspension(...)` with `suspensionReason: 'INTERRUPT_RAISED'`.
    * The runtime evaluates `.pauseSiblingForksInPartitions((v) => repoTopology.affectedBy(v.partition))` against the `activePartitions` of all sibling forks dispatched in the parent's open tool-use batch:
        1. **Sibling Mid-Turn (Executing a Tool or LLM Turn):** The runtime lets the sibling's current tool call or LLM generation finish, ensures any remaining `tool_use` blocks in that turn receive a valid `tool_result` (canceling unstarted sibling-internal tool calls in that turn if needed), and persists its `ContinuationFrame[]` stack with `pausedAtPhase: 'TOOL_BOUNDARY'`.
        2. **Sibling Inside `beforeStop` Checks or `H.loop.evaluate` (`evaluator`):** Because the sibling worker already emitted its final structured output `assistant` turn, its trailing message frame has no `tool_result` block. The runtime aborts the in-flight `beforeStop` check or `evaluator` session, rolls the enclosing `loop-frame` phase back to `'act'`, and persists the `ContinuationFrame[]` stack with `pausedAtPhase: 'BEFORE_STOP_GATE'`.
        3. **Sibling Already Completed & Committed in the Same Batch:** If a fast sibling fork in the affected partition set already completed `commitChild` before the interrupt was raised, its receipt is recorded in `alreadyCommittedSiblingForks` on the interrupt return payload so the parent knows those edits already landed in `parentHandle`.
* **Normal Wire `tool_result` Completion to the Single Parent Timeline:**
    * The raising child's `.fork()` tool call in the parent's open batch resolves normally with:
~~~json
{
  "status": "SUSPENDED_ON_INTERRUPT",
  "suspendedForkId": "fork_api_01",
  "interruptId": "contract-violation",
  "payload": { "partition": "db", "brokenInvariant": "...", "proof": "...", "proposedPatch": "..." },
  "pausedSiblingForkIds": ["fork_db_01"],
  "alreadyCommittedSiblingForks": []
}
~~~
* Each paused sibling's `.fork()` tool call in the parent's open batch resolves normally with:
~~~json
{
  "status": "PAUSED_BY_SIBLING_INTERRUPT",
  "suspendedForkId": "fork_db_01",
  "triggeredByForkId": "fork_api_01",
  "activePartitions": ["db"]
}
~~~
* **Parent Resolution & Built-In `resumeFork` Tool:**
    * Any parent agent declaring `.onChildInterrupt(...)` automatically mounts the `resumeFork` capability tool:
~~~ts
const ResumeForkInputSchema = z.object({
  suspendedForkIds: z.array(z.string()).min(1),
  action: z.enum(['resume', 'abort']).default('resume'),
  resolutionSummary: z.string(),
});
~~~
* **Dirty-Safe `syncChild` Rebase, Wire-Safe Resumption & Enclosing Loop Completion:**
    * For each `suspendedForkId` with `action: 'resume'`, the runtime acquires the write lock on `parentHandle` and runs `const syncRes = await scope.syncChild(parentHandle, childHandle)` to dirty-safely stash, rebase onto the updated `parentHandle` HEAD, and reapply the child's uncommitted edits.
    * **Case A (`suspensionReason === 'INTERRUPT_RAISED'`):** Appends `{ resolution: resolutionSummary, updatedTopologyContracts, sync: syncRes.data, conflict: syncRes.status === 'conflict' ? syncRes.conflictedSummary : undefined }` as the `tool_result` of the child's suspended interrupt tool call.
    * **Case B (`suspensionReason === 'PAUSED_BY_SIBLING_INTERRUPT'` at `TOOL_BOUNDARY`):** Calls `LedgerStore.appendTrailingToolResultNote(...)` to append `\n\n[TOPOLOGY_SYNC]: ${resolutionSummary}\n${JSON.stringify(syncRes.data)}` directly onto the child's trailing `tool_result` frame.
    * **Case C (`suspensionReason === 'PAUSED_BY_SIBLING_INTERRUPT'` at `BEFORE_STOP_GATE`):** Appends a synthetic gate-rejection `user` frame (`[TOPOLOGY_SYNC_REVERIFY]: Upstream contract updated (${resolutionSummary}). Verify your implementation against the synced workspace before completing.`) after the child's prior `assistant` completion turn—preserving strict `assistant -> user -> assistant` alternation and forcing the worker to re-verify before `beforeStop`.
    * **Full Continuation-Stack Execution & Recursive Interrupt Safety:** As the resumed inner `agent-frame` completes and passes `beforeStop`, execution pops up the restored `ContinuationFrame[]` stack—inheriting `loop-frame.grantedLoopLeases` and running any enclosing `loop-frame` (`evaluator` in `verifiedWorkerLoop`) before invoking `commitChild`. The `resumeFork` tool returns a per-fork array of discriminated results (`COMPLETED | SUSPENDED_ON_INTERRUPT | PAUSED_BY_SIBLING_INTERRUPT`), so if a resumed fork raises a second `contractViolation`, it cleanly re-suspends and returns a new `SUSPENDED_ON_INTERRUPT` entry to the parent.

## 3.8 Iterative Refinement Loops (`H.loop`) & Loop-Scoped Lease Inheritance

`H.loop(id)` implements `StepExecutable<TIn, TOut, THandle>` by coupling an action step with an evaluation step:

* `.input(inSchema).output(outSchema).partitions(mapper).maxIterations(N).preserveActorSession(boolean).distillLessonsInto(lessons)`
* `.act(stepId, actor, $act => ...)`: Executes `actor`. When `preserveActorSession` is `true`, subsequent iterations resume the actor's existing conversation session with `feedbackMapper(evalResult)`.
* `.evaluate(stepId, evaluatorActor, { mapInput: (loopInput, actOutput, scopeReceipt) => evalInput, acceptWhen: (evalOut) => boolean, feedbackMapper: (evalOut) => string })`: Before invoking `evaluatorActor`, the harness calls `IsolationScope.inspect(scopeHandle)` and passes the resulting `scopeReceipt` into `mapInput`.
* **Loop-Scoped Lease Inheritance (`grantedLoopLeases`):** Any `LeaseDelta` granted to the `.act()` actor during Iteration $k$ (for example, `leaseAdjudicator` unlocking an existing test file) is recorded on the enclosing `loop-frame.grantedLoopLeases` and automatically inherited by Iteration $k+1..N$—even when Iteration $k+1$ escalates to a new model via `prepareFork()` or resumes after a sibling-interrupt rollback.
* **Derived Loop Clones (`.withTools(...ToolDefinition[])` & `.withPolicy(policy)`):**
    * Calling `loop.withTools(...extraTools)` returns a derived `H.loop` clone whose inner `.act()` actor appends `extraTools` to its toolset for that invocation.
    * Calling `loop.withPolicy(newPolicy)` returns a derived `H.loop` clone whose inner `.act()` actor applies `newPolicy` (preserving all actor-level `.onInterrupt()` handlers on the `.act()` actor while leaving the `.evaluate()` actor's `readOnlyPolicy` intact).
* **Model Escalation Across Preserved Sessions:** When `preserveActorSession(true)` is enabled on an actor backed by a model pool with `.escalateOnRetry()`, an evaluation rejection (`acceptWhen(evalOut) === false`) counts as a retry trigger. If Iteration $k$ executed on model $M_1$ and Iteration $k+1$ escalates to model $M_2$ ($M_1 \ne M_2$), the runtime passes the session history through `ModelDriver.prepareFork({ historyMode: 'clone-transcript', parentChain, forkPointMessageId: leafMessageId, wirePrefix, childRoleContextFrameText }, { modelId: M_2, substituteTombstones: true })` before invoking Iteration $k+1$.
* **Continuation-Stack Interrupt Bubbling:** Any `H.interrupt` raised inside `.act()` or `.evaluate()` not caught by an actor-level or step-level `.onInterrupt()` handler pushes the active `loop-frame` onto `continuationStack` and bubbles up transparently to the enclosing `.fork()`, `.speculate()`, or `H.flow` step.
* `.returnOutputFrom(actStepId)`: Projects the accepted action step's output as the loop's output.

## 3.9 Declarative Flows (`H.flow`), Crash Recovery, `scopeReceipt` Projection & Interrupt Edges

`H.flow(id).input(inSchema).scope(isolationScope).telemetry(telemetryCollector)` chains sequential `.step()` and conditional `.branch()` nodes.

* **Reboot Crash Recovery (`getInterruptedStepsOnBoot` + `reattachRoot`/`reattachChild`):** On startup, the runtime queries `LedgerStore.getInterruptedStepsOnBoot()`, calls `IsolationScope.reattachRoot(runId, baseScopeCheckpoint)` (and `BranchableScope.reattachChild` for any active or suspended child forks), restores the serialized `ContinuationFrame[]` stack into `ExecutionContext.resumeContinuationStack`, and resumes execution from the exact `H.loop` iteration, `agent-frame` message chain, and `pendingPreFlightCall`.
* **Branching:** `.branch(stepId, $b => $b.output(branchOutSchema).when(pred, $sub => ...).otherwise($sub => ...))` requires all branches to produce `branchOutSchema`.
* **Step Input Projection with Live `scopeReceipt`:** `.inputFrom((flowInput, priorStepOutputs, scopeReceipt) => stepInput)` preserves immutable access to `flowInput` alongside all prior step outputs (restored on crash recovery via `LedgerStore.createOrResumeRun().completedStepOutputsJson`) and the latest `TReceipt` from `IsolationScope.inspect(scopeHandle)`.
* **Declarative Interrupt Edges (`.onInterrupt(interrupt, $intr => ...)`):**

**Edge Mode 1 — Adjudication & Lease Elevation (with Suspended Pre-Flight Tool Replay):**

~~~ts
$intr
  .adjudicateWith(adjudicatorExecutable, (flowInput, intrPayload) => adjudicatorInput)
  .onInterrupt(nestedInterrupt, ($esc) =>
    $esc
      .ask(human, humanResponseSchema)
      .resumeWith((humanResponse) => feedbackStringToAdjudicator),
  )
  .elevateLeaseWhen(
    (adjudicatorVerdict) => adjudicatorVerdict.approved,
    (adjudicatorVerdict) => leaseDelta,
  )
  .resumeWith((adjudicatorVerdict) => feedbackStringToInterruptedActor)
~~~

**Edge Mode 2 — Step Replacement / Promotion with Mandatory Scope Cleanup (`.onAbort`):**

~~~ts
$intr
  .onAbort(abortHook) // Optional override; defaults to policy's .onAbort() or CheckpointableScope.restoreCheckpoint(baseScopeCheckpoint)
  .replaceWith(
    replacementExecutable,
    (flowInput, intrPayload, stepTelemetry) => replacementInput,
  )
~~~

Whenever a step is terminated and replaced via `.replaceWith()`, the runtime guarantees that the `replacementExecutable` never inherits dirty, uncommitted mutations left behind by the aborted actor:

1. If `stepTelemetry.abortMeta` was not already populated by `H.policy.onLimitExceeded`, the runtime checks if `.onAbort(abortHook)` is configured on the `$intr` edge (or on the interrupted actor's `H.policy`). If present, it executes `const abortMeta = await abortHook.execute(scopeHandle, runId)` and attaches `abortMeta` to `stepTelemetry.abortMeta`.
2. If no `AbortHook` is configured on either the interrupt edge or the policy, the AST compiler requires `CheckpointableScope` and the runtime automatically executes `await scope.restoreCheckpoint(scopeHandle, stepBaseScopeCheckpoint)` before starting `replacementExecutable`.

## 3.10 Lanes (`H.lane`), Ledger Compaction & Root Harness (`H.harness`)

* **`H.lane(id)`:** Binds `.input(schema)`, `.key(mapper)`, `.tracker(adapter, $t => ...)`, `.flow(flow)`, `.concurrency(N)`, `.priority('low' | 'normal' | 'high' | 'critical')`, `.agingMinutes(M)`, `.waitFor(depsMapper, onAbandonedState)`, `.maxCostUsd(limit, approver)`, `.retry($r => ...)`, and `.onSignal(sig, $s => $s.update(mapper).rewindTo(stepId, { onRewind?: ScopeRewindHook }))`.
* **`H.harness(id)`:** Composes `.ledger(ledgerStore)`, `.pools(...pools)`, `.streams(...streams)`, `.lanes(...lanes)`, `.onSignal(sig, $s => $s.notify(human, mapper))`, and `.expose(...controlPlaneAdapters)`.

---

# 4. Peer Adapter Package Specifications

## 4.1 `@harness-dsl/claude` & `@harness-dsl/openai`

* **`@harness-dsl/claude`:** Implements `ModelDriver` for Anthropic API and Claude CLI seat pools (`claude.cliAccount(id).configDir(path)`, `claude.cliAccount(id).apiKey(envRef)`, `claude.model(id, { id }).accountPool(pool)`). Uses `CompiledWirePrefix` from `H.prefixGroup` so top-level `system` (and role-scoped or union `tools`) definitions remain byte-identical across invocations. Preserves exact Anthropic wire JSON (including `thinking` blocks and cryptographic `signature` fields) in `rawWireFrame`. On `prepareFork`:
    * If `ctx.historyMode === 'shared-prefix-only'`, starts a clean transcript after the cached `CompiledWirePrefix` seeded with `ctx.childRoleContextFrameText`.
    * If `ctx.historyMode === 'clone-transcript'` and `target.substituteTombstones === false` (same-model fork), replays `rawWireFrame` untouched up to `forkPointMessageId` with `cache_control: { type: 'ephemeral' }` and appends `ctx.childRoleContextFrameText`.
    * If `target.substituteTombstones === true` (cross-model retry escalation where provider KV cache and thinking signatures do not transfer), substitutes `compactedTombstone` strings on completed skill activation frames and projects `CanonicalMessage` frames.
* **`@harness-dsl/openai`:** Implements `ModelDriver` for OpenAI Responses API and Codex CLI seats (`openai.account(id)`, `openai.model(id, { id })`), supporting `shared-prefix-only` warm prefix forks, server-side `previous_response_id` branching on `clone-transcript` same-model forks, and `compactedTombstone` substitution on cross-model escalations.

## 4.2 `@harness-dsl/node` (OS Subprocesses, Stream Checks, Daemons & MCP)

Owns all POSIX/OS process execution, standard stream contracts, and dynamic TCP port allocation:

* **`local.runner({ slots: number }): Runner`:** Manages local subprocess concurrency slots, process-group cleanup (`SIGKILL` on orphaned trees), and ephemeral port locks.
* **`local.command(id)`:** Implements `StepExecutable` (and `.asTool(): ToolDefinition`, `.asCheck(): Check`). Enforces `.stdin('closed')` or `.stdin(bufferMapper)` so interactive CLI prompts never hang runner slots. Supports `.unrepeatable(preCheckCmd, { key })`. Calling `.asTool()` omits `describeEffects` so any workspace mutations performed by the subprocess are post-flight diffed and policy-checked by `CheckpointableScope.diffEffects()`.
* **`local.streamCheck(id)`:** Implements `Check` (and `.asTool(): ToolDefinition`, `StepExecutable`). Streams subprocess `stdout`/`stderr` and supports `.circuitBreakWhenStdout(regex, { graceLinesAfterMatch })` to abort slow verification suites on the first failure stack trace. Calling `.asTool()` exposes an in-session verification tool that **omits `describeEffects`**—ensuring that if code executed during a test run (such as a newly created test file) attempts to write to protected files (`packages/*/src/index.ts`, `PRODUCT_SPEC.md`, or existing `*.test.ts` files), `CheckpointableScope.diffEffects()` detects the unauthorized write post-flight, rolls back the working tree delta via `restoreCheckpoint`, and raises the policy's violation interrupt.
* **`local.daemon(id)`:** Implements `H.Service`. Declares static `toolSchemas` up front for all `.interact()` tools so wire-level tool definitions remain static across skill activation/deactivation. Manages a stateful background process bound to `.lifecycle('scope' | 'fork' | 'skill')` with dynamic conflict-free port allocation (`.port(name)`), `.readyWhenStdout(regex)`, and framed turn-based interaction tools (`.interact(toolName, { command, frameDelimiter, idleSettleMs, timeoutSeconds })`).
* **`mcp.server({ port: number }): ControlPlaneAdapter`:** Exposes harness runtime status and signal triggers over Model Context Protocol.

## 4.3 `@harness-dsl/fs` (Filesystem Effects, Partition Maps, Guards & Tools)

Owns all POSIX file path matching, filesystem guards, and file telemetry:

* **`FsToolEffect`:** `{ kind: 'fs:effect', attributes: { mode: 'read' | 'write', paths: readonly string[] } }`.
* **`fs.text(filePath): Source<string>`:** Lazily loads UTF-8 file text with SHA-256 digest.
* **`fs.matchGlobs(globs: string[], mode?: 'read' | 'write' | 'any'): EffectMatcher`:** Matches `FsToolEffect` paths against glob patterns.
* **`fs.partitionMap(topology, Record<PartitionId, { globs: string[], boundaryGlobs: string[] }>)`:** Maps logical `H.topology` partitions to physical filesystem globs and public boundary files.
* **`fs.inPartition(partitionMap, partitionId): ScopePredicate`** & **`fs.boundaryGuard(partitionMap): PolicyGuard`:** Connects `partitionMap` to scoped rules/skills and blocks unapproved edits to `boundaryGlobs`.
* **`fs.writeGuard({ denyGlobs: string[], allowGlobs?: string[] }): PolicyGuard`** & **`fs.allowWriteGlobs(globs: string[]): LeaseDelta`**.
* **`fs.maxFilesMutated(count: number): QuotaTripwire`:** Trips when distinct mutated file paths exceed `count`.
* **`fs.telemetry(): TelemetryCollector<{ filesRead: string[], filesMutated: string[] }>`:** Collects accessed file paths from `FsToolEffect` records into `stepTelemetry.custom`.
* **`fs.regexCheck(id, { targetGlobs, forbidPattern, violationMessage }): Check`**.
* **`fs.jsonlLessonStore({ definitionsDir: string, statsPath: string, lockFile: string }): LessonStore`:** Strictly obeys Invariant 5 by resolving all paths against the harness host root, never touching active worktree directories during `admit()` or `recordOutcomes()`. Splits immutable, content-addressed lesson definition files (`<definitionsDir>/<lessonId>.json`, storing `id`, `partition`, `directive`, `epochAtCreation` so git-tracking never suffers adjacent-line EOF `.jsonl` rebase conflicts) from high-frequency, git-ignored telemetry counters (`statsPath`, storing `recentOutcomes`, `totalCleanPasses`, `totalViolated`), synchronized across concurrent runs via `lockFile`.
* **`fs.codingTools(runner)` & `fs.readOnlyTools(runner)`:** Workspace-jailed file and search tools emitting `FsToolEffect` descriptors with static `describeEffects` implementations.

## 4.4 `@harness-dsl/git` (CoW Worktree Scope, Crash Reattachment, Deterministic Git-Index Checkpoints & Reconciliation)

Owns all git version control and worktree isolation mechanics:

* **`git.ScopeReceiptSchema`:**

~~~ts
z.object({
  headRef: z.string(),
  branchName: z.string().optional(),
  baseBranch: z.string().default('main'), // Tracks stacked-PR prerequisite base branch
  diffStat: z.string(),
  mutatedFiles: z.array(z.string()),
})
~~~

* **`git.SyncReceiptSchema`:**

~~~ts
z.object({
  rebasedOntoRef: z.string(),
  baseBranch: z.string().default('main'),
  updatedFiles: z.array(z.string()),
})
~~~

* **`git.AbortMetaSchema`:** `z.object({ abortedSnapshotRef: z.string(), resetToRef: z.string() })`.
* **`git.cowWorktree({ repo, dir }): BranchableScope<GitWorktreeHandle, GitScopeReceipt, GitSyncReceipt> & CheckpointableScope<GitWorktreeHandle, GitScopeReceipt>`:**
    * **Portable CoW Clone Fallback Chain, Path-Bound Cache Exclusion & Crash Reattachment (`reattachRoot` / `reattachChild`):**
        * Probes the host filesystem on initialization and cascades automatically:
            1. `cp -c` (macOS APFS) or `cp --reflink=always` (Linux Btrfs / XFS) linked to the host repository's shared git object store.
            2. `git worktree add` + `cp -al node_modules` (hardlinked `node_modules` tree on standard Linux `ext4` filesystems where reflinks are unsupported, sharing inode blocks in ~40ms).
        * `.excludeFromCloneGlobs(['dist/**', '.next/**', 'coverage/**', '**/*.tsbuildinfo'])` omits path-embedded incremental build caches during worktree cloning so tools that embed absolute paths in caches never miscompile.
        * Implements `reattachRoot(runId, checkpoint?)` and `reattachChild(parentHandle, forkId, checkpoint?)` by rebinding the deterministic worktree directory `<dir>/<runId>` (or `<dir>/<runId>/forks/<forkId>`) on disk—or recreating it from the host-pinned checkpoint git tree object if the ephemeral directory was cleaned—and restoring `checkpoint` so interrupted runs recover seamlessly after a process restart.
    * **Deterministic Partition-Scoped Git-Index Checkpoints (`serializeCheckpoint` / `restoreCheckpoint` / `diffEffects`):**
        * Configured via `.checkpointPolicy({ partitionMap, excludeGlobs: ['dist/**', '.next/**', 'coverage/**'], maxUntrackedFileSizeBytes: 1_048_576 })`.
        * `serializeCheckpoint` runs a deterministic `git status --porcelain=v2 -z --untracked-files=all` across the repository (excluding `.gitignore` and `excludeGlobs`), records SHA-256 hashes of all tracked dirty files and qualifying untracked files smaller than `maxUntrackedFileSizeBytes` (1 MiB), and snapshots the working state into a temporary git tree object in the host object store.
        * Post-flight `diffEffects(fromCheckpoint, handle)` re-runs the `git status --porcelain=v2 -z` query and compares file hashes against `fromCheckpoint` across all repository paths (including root specs like `PRODUCT_SPEC.md`, `TECH_DESIGN.md`, `openapi.yaml`, and all partitions in `partitionMap`) to synthesize exact `FsToolEffect (mode: 'write')` records with 100% determinism across macOS and Linux. Any `PolicyGuard` rollback restores `fromCheckpoint` and unlinks newly created untracked files recorded in the status delta.
    * **Zero-Pollution Conflict-Bouncing `commitChild` & Dirty-Safe `syncChild`:**
        * `commitChild(child, parent)` checks if `child` is a clean fast-forward over `parent`. If `parent` has advanced, `commitChild` rebases `child` onto `parent` *inside `child`*. If a merge conflict occurs, `parent` remains completely untouched and `commitChild` returns `{ status: 'conflict', conflictedSummary, data }` so Core bounces the conflict back into the child agent session for repair.
        * `syncChild(parent, pausedChild)` snapshots scoped uncommitted edits in `pausedChild`, rebases `pausedChild` onto `parent`'s updated `HEAD`, and re-applies the uncommitted edits via 3-way file merge (`git merge-file`). If conflict markers (`<<<<<<<`) are produced, `syncChild` returns `{ status: 'conflict', conflictedSummary, data }` and arms `conflictCleanCheck` (which rejects `beforeStop` until `git diff --check` reports zero conflict markers).
    * **Stacked-PR Prerequisite Lineage (`syncRoot`):**
        * Before `release()` deletes an ephemeral CoW worktree directory from disk, it pins the worktree's terminal commit to `refs/harness/completed/<run-id>` (and speculative branch commits to `refs/harness/candidates/<run-id>/<branch-index>`) in the host repository's git object store and prunes ephemeral checkpoint objects.
        * When `syncRoot(rootHandle, prereqReceipts)` rebases a resumed parent Task Root Worktree onto a completed prerequisite's `headRef`, it checks whether the prerequisite's `branchName` (e.g., `fix/#102`) has been merged into `origin/main`. If not yet merged, `syncRoot` sets `rootHandle.baseBranch = prereqReceipt.branchName` (`fix/#102`).
    * **Reconciliation Strategies (`.reconcileStrategy('rebase-onto-base' | 'batch-merge-train', opts)`):**
        * `'rebase-onto-base'` (for PR-opening lanes): Rebases each completed Task Root Worktree onto the latest commit of its own `scopeReceipt.baseBranch` (`origin/main` or its stacked prerequisite branch) and runs `verifyWith` so each feature branch PR contains only its own commits.
        * `'batch-merge-train'` (for direct branch-landing / auto-merge queues): Speculatively constructs a cumulative rebase chain ($R_1, R_1 + R_2, \dots, R_1 + \dots + R_k$, up to `maxBatchSize`) across completed runs landing into the target branch, runs `verifyWith` once on the cumulative head $R_k$ (fast-tracking partition-disjoint changes), and bisects only if $R_k$ fails verification.
* **`git.snapshotAndReset(): AbortHook<GitWorktreeHandle, GitAbortMeta>`:** Commits dirty working tree state to `refs/harness/aborted/<run-id>` in the host repository and hard-resets the worktree to base `HEAD`.
* **`git.keepWorktree()` & `git.resetWorktree()`:** `ScopeRewindHook` implementations for `.rewindTo()`.
* **`git.publicSurfaceCrossTester({ runner, partitionMap }): CrossVerifier`:** Parses AST imports of newly added test files across speculative worktrees and cross-executes tests that import exclusively from `boundaryGlobs`.
* **`git.refReaderTools(runner)` & `git.candidateComparisonTools(runner)` & `git.commitAndPush(id, opts)`:**
    * `git.refReaderTools(runner)` exposes read-only git object inspection tools (`readRefFile`, `diffRefs`, `listRefFiles`) implemented via pure `git show` / `git diff-tree` against the object store (`describeEffects: () => []`) so `coordinator` can inspect `refs/harness/aborted/<run-id>` snapshots after a fast-path `scopeTripwire` or `contractViolation` reset.
    * `git.candidateComparisonTools(runner)` exposes candidate inspection and benchmark tools (`diffCandidates`, `readCandidateFile`, `evalInCandidates`) capable of reading `refs/harness/candidates/<run-id>/<branch-index>` during both `candidateArbiter` evaluation and `refineWinnerWhen` cross-pollination.

## 4.5 `@harness-dsl/markdown`, `@harness-dsl/sqlite`, `@harness-dsl/postgres`, `@harness-dsl/github`, `@harness-dsl/slack`

* **`@harness-dsl/markdown`:** `md.globalRules(glob)`, `md.scopedRule(path)`, `md.scopedRules(glob)`, `md.skill(path)`, `md.skills(glob)`.
* **`@harness-dsl/sqlite` & `@harness-dsl/postgres`:** `ledger(uri)`, `topologyStore(uri)`, `lessonStore(uri)`, `globalRules(uri, { table })`.
* **`@harness-dsl/github`:** `github.issues(opts)`, `github.webhookStream(opts)`.
* **`@harness-dsl/slack`:** `slack.webhook(url)`, `slack.bot(opts)`.

---

# 5. Domain-Generality Verification: Non-Coding Financial Harness Example

Because `@harness-dsl/core` separates Tier-1 `IsolationScope` (`acquireRoot`, `reattachRoot`, `inspect`, `release`) from `CheckpointableScope` and `BranchableScope`, non-coding domain adapters (such as `@harness-dsl/stripe` and `@harness-dsl/netsuite`) implement only the base transactional scope without faking git rebase semantics:

~~~ts
import { H, z } from '@harness-dsl/core';
import { claude } from '@harness-dsl/claude';
import { postgres } from '@harness-dsl/postgres';
import { slack } from '@harness-dsl/slack';
import { stripe } from '@harness-dsl/stripe';
import { netsuite } from '@harness-dsl/netsuite';

const discrepancyItem = z.object({
  discrepancyId: z.string(),
  accountRegion: z.enum(['us-east', 'eu-west']),
  varianceUsd: z.number(),
});

const settlementReceipt = z.object({
  journalEntryId: z.string(),
  reconciledAmountUsd: z.number(),
});

const highValueApprovalRequest = H.interrupt('high-value-approval').payload(
  z.object({ proposedJournalId: z.string(), amountUsd: z.number(), reason: z.string() }),
);

const financeController = H.human('finance-controller').notify(slack.webhook(H.env('FINANCE_SLACK_URL')));
const opus = claude.model('opus', { id: 'claude-opus-4-6' });

// Policy guards & tripwires operate over static describeEffects() on Stripe/NetSuite API tools
const autoReconcilePolicy = H.policy('auto-reconcile-bounds')
  .guard(netsuite.forbidClosedPeriodPosting())
  .tripwire(stripe.maxRefundQuotaUsd(500))
  .maxTurns(6)
  .onAbort(netsuite.rollbackDraftJournal())
  .onLimitExceeded(($l) =>
    $l.flushWithInterrupt(highValueApprovalRequest).onAbort(netsuite.rollbackDraftJournal()),
  );

const reconciliationAgent = H.agent('reconciler')
  .model(opus)
  .policy(autoReconcilePolicy)
  .tools(stripe.readTools(), netsuite.journalTools())
  .beforeStop(netsuite.balanceZeroCheck())
  .input(discrepancyItem)
  .partitions((item) => [item.accountRegion])
  .output(settlementReceipt)
  .canRaise(highValueApprovalRequest);

export const reconciliationFlow = H.flow('reconcile-discrepancy')
  .input(discrepancyItem)
  .scope(netsuite.draftJournalScope()) // Implements Tier-1 IsolationScope<NetSuiteDraftHandle, DraftJournalReceipt>
  .step('attempt-reconcile', reconciliationAgent, ($s) =>
    $s.onInterrupt(highValueApprovalRequest, ($intr) =>
      $intr
        .ask(financeController, z.object({ approved: z.boolean(), note: z.string() }))
        .elevateLeaseWhen((d) => d.approved, () => stripe.allowRefundUpToUsd(10_000))
        .resumeWith((d) => `Controller decision: ${d.approved ? 'Approved' : 'Denied'} (${d.note})`),
    ),
  )
  .exit('done');
~~~