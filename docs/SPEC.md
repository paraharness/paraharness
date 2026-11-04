# @harness-dsl Framework & Ecosystem Specification (V7)

# 1. Scope, Design Principles & Package Topology

`@harness-dsl` is a declarative, durable execution framework for orchestrating autonomous LLM actors, deterministic tools, lifecycle-bound services, and human escalations over isolated execution scopes.

The architecture enforces a strict boundary between **Execution Topology** (`@harness-dsl/core`) and **Environment/Vendor Adapters** (peer packages). `@harness-dsl/core` contains zero concepts specific to software engineering, source-code testing, POSIX filesystems (read/write/execute modes, file globs), OS subprocesses (`argv`, `stdin`, `stdout`, TCP ports), version control (git, commits, diffs, rebasing), relational databases, or LLM provider wire formats.

## 1.1 Package Boundaries

| Package | Responsibility |
| :--- | :--- |
| **`@harness-dsl/core`** | Declarative AST compilation, Run-Immutable Unified Warm-Fork Prefix compilation (`H.prefixGroup` with `'role-scoped'` and `'union'` tool modes, AST declaration-order pinning), durable state machine transitions, reboot-safe tree-structured continuation call-stack (`ContinuationFrame[]` including `'fork-batch-frame'` and `'speculate-frame'`) persistence serialized through a per-step async queue, capability-tiered isolation scope contracts (`IsolationScope`, `CheckpointableScope`, `BranchableScope`) with crash-recovery handle reattachment (`reattachRoot`, `reattachChild`), per-handle shared-read / exclusive-write scope locks (`ScopeLockManager`) keyed on `ToolEffect.mutatesScope`, downward fork/join lifecycle (`historyMode: 'shared-prefix-only' \| 'clone-transcript'`) with idempotent conflict-bounce reconciliation, speculative execution tournaments with deferred escalation parking (`PARKED_ON_ESCALATION`) and non-destructive contested arbitration (`select-winner` vs `unpark-escalation` vs `reject-all`), upward interrupt suspension (`suspendAndReturnToParent`) with turn-batch sibling pause barriers, automatic service quiescing, and native `resumeFork` resolution on a single parent timeline, loop-scoped capability lease inheritance with sequential turn-batched pre-flight/post-flight tool replay (`PendingToolBatch`), quota tripwires with KV-cache-preserving `toolChoice: 'none'` epistemic flush turns, run-isolated Copy-on-Write relational topology epoch tracking (`affectedBy`, `dependentsOf`) with signal-correlated overlay commits, explicit `.partitions()` extraction, capacity pool & priority-boosted prerequisite scheduling, deduplicated 4-state evidence-based lesson scoring math, hierarchical rewind drain barriers, and ledger lifecycle orchestration. |
| **`@harness-dsl/claude`** | `ModelDriver` implementation for Anthropic HTTP API and Claude CLI seat pools (`~/.claude-*` JSONL session synthesis, cryptographic `thinking` signature preservation, role-scoped vs union prefix wire assembly, `shared-prefix-only` vs `clone-transcript` fork preparation, cross-model-only fork-boundary tombstone substitution, wire-safe `appendToolResultNotes` with `targetCallId`, `toolChoice: 'auto' \| 'none'`, and ephemeral KV-cache breakpoint injection). |
| **`@harness-dsl/openai`** | `ModelDriver` implementation for OpenAI Responses API (`previous_response_id` server-side branching, encrypted reasoning token retention, role-scoped vs union prefix wire assembly, wire-safe `appendToolResultNotes` with `targetCallId`, `toolChoice: 'auto' \| 'none'`, and cross-model-only fork-boundary tombstone substitution) and Codex CLI seats. |
| **`@harness-dsl/node`** | Local OS process slot and daemon runner (`local.runner({ slots, maxDaemons })`), one-shot subprocess commands (`local.command`), streaming subprocess checks with regex circuit-breakers (`local.streamCheck`), framed PTY/pipe background services with graceful shutdown (`local.daemon` with `.stopCommand()`), and Model Context Protocol control-plane server (`mcp.server`). Subprocess `.asTool()` adapters omit static `describeEffects` so workspace mutations are always verified post-flight via `CheckpointableScope.diffEffects()`. |
| **`@harness-dsl/fs`** | Filesystem `EffectMatcher` globs, write-policy guards, file-count quota tripwires (`fs.maxFilesMutated`), regex/AST deterministic `Check` implementations, `Source<string>` file loaders, topology-to-glob partition maps (`fs.partitionMap`), host-root content-addressed lesson stores (`fs.jsonlLessonStore` with kernel `flock(2)` advisory locking and atomic rename), file telemetry collectors, and workspace-jailed file tool bundles. |
| **`@harness-dsl/git`** | Copy-on-Write (CoW) hierarchical git worktree scope (`git.cowWorktree`) implementing `BranchableScope` and `CheckpointableScope` with immutable `baseRef` lineage tracking, crash-recovery worktree reattachment (`reattachRoot`/`reattachChild`), portable CoW clone fallback (`cp -c` / `cp --reflink=always` -> `git worktree add` + symlink-preserving recursive `node_modules` hardlink clone), path-cache exclusion (`excludeFromCloneGlobs`), `GIT_CEILING_DIRECTORIES` subprocess isolation, `headSha`-verified symmetric git-index/hash dirty working-tree checkpointing (`serializeCheckpoint` / `diffEffects`), side-effect-free temporary-index commit synthesis (`inspect`) and candidate ref pinning, zero-pollution conflict-bouncing `commitChild`/`syncChild`/`syncRoot`, stacked-PR `baseBranch` lineage tracking, host-pinned completion/aborted refs, snapshot-and-reset abort hooks (`git.snapshotAndReset`), lockfile-hash setup gates, isolated PR-branch reconciliation (`rebase-onto-base`) and cumulative landing merge trains (`batch-merge-train`), AST-gated public-boundary cross-verifiers, ref reader tools (`git.refReaderTools`), candidate comparison tools (`git.candidateComparisonTools`), and commit/push executables (`git.commitAndPush`). |
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
6. **Run-Immutable Wire Prefix Invariant:** Sources bound to `H.prefixGroup().sharedGrounding()` are compiled in AST declaration order and snapshotted once in `LedgerStore` when a flow run starts. Dynamic state that can mutate mid-run (such as `H.topology` partition contract epochs, recalled lessons, or in-run edits made by an actor to grounding files like `TECH_DESIGN.md` or `PRODUCT_SPEC.md`) is never re-interpolated into the wire `system` prompt; instead, in-run grounding diffs and topology updates are injected exclusively into the Turn-0 `[ROLE_AND_SCOPE_CONTEXT]` user frame and `[TOPOLOGY_SYNC]` delta frames so byte 0 of the provider KV cache never invalidates mid-run.

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
// E.g. @harness-dsl/fs emits { kind: 'fs:effect', mutatesScope: mode === 'write', attributes: { mode: 'read' | 'write', paths: string[] } }
// E.g. @harness-dsl/stripe emits { kind: 'billing:effect', mutatesScope: true, attributes: { op: 'refund', amountUsd: number } }
export interface ToolEffect {
  readonly kind: string;
  readonly mutatesScope?: boolean;
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
  // or same-model 'clone-transcript' forks (preserving 100% KV-cache hit rate and thinking signatures);
  // substituted only by prepareFork() when escalating across distinct models (sourceModelId !== targetModelId).
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
  // In 'union' mode (used for 'clone-transcript' forks), contains the deterministic byte-identical union
  // across the group (with static '[Role: <actorId>]' tags so descriptions never vary per caller).
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
    readonly toolChoice?: 'auto' | 'none';
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
  // Appends trailing synchronization notes ([TOPOLOGY_SYNC], [PREREQUISITE_SYNC], [SERVICE_REACQUIRED],
  // [LIMIT_EXCEEDED_FLUSH]) to a tool_result frame inside both rawWireFrame and frame.canonical
  // (targeting targetCallId when specified, or the last tool_result block in the frame).
  appendToolResultNotes(
    frame: WireFrameRecord,
    notes: readonly string[],
    targetCallId?: string,
  ): Promise<WireFrameRecord>;
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
  readonly violatedEffects: readonly ToolEffect[];
  readonly violationSummary: string;
}

export interface PendingToolBatch {
  readonly completedResults: ReadonlyArray<{
    readonly callId: string;
    readonly content: string;
    readonly isError?: boolean;
  }>;
  readonly blockedCalls: readonly PendingPreFlightCall[];
  readonly unstartedCalls: ReadonlyArray<{
    readonly callId: string;
    readonly toolName: string;
    readonly argsJson: string;
  }>;
}

// Serialized tree-structured execution frame preserving composite H.loop, H.agent, active downward
// forks (.fork / resumeFork), and speculative tournaments (.speculate) across both upward interrupt
// suspensions (SuspendedForkRecord) and process crash recovery (LedgerStore).
export type ContinuationFrame =
  | {
      readonly kind: 'agent-frame';
      readonly agentId: string;
      readonly stepExecId: string;
      readonly inputJson: string;
      readonly leafMessageId: string | null;
      readonly activeLeases: readonly LeaseDelta[];
      readonly activeSkillIds: readonly string[];
      readonly observedEffects: readonly ToolEffect[];
      readonly injectedScopedRuleIds: readonly string[];
      readonly pausedAtPhase: 'ACTIVE_TURN' | 'TOOL_BOUNDARY' | 'BEFORE_STOP_GATE';
      readonly neutralSyncContinuation?: boolean;
      readonly pendingToolBatch?: PendingToolBatch;
    }
  | {
      readonly kind: 'loop-frame';
      readonly loopId: string;
      readonly stepExecId: string;
      readonly loopInputJson: string;
      readonly iteration: number;
      readonly phase: 'act' | 'evaluate';
      readonly preservedActLeafMessageId: string | null;
      // Loop-level lease, effect, and scoped-rule accumulators: persist across Iteration k+1
      // (including across cross-model escalations and sibling-interrupt rollbacks).
      readonly grantedLoopLeases: readonly LeaseDelta[];
      readonly observedEffects: readonly ToolEffect[];
      readonly injectedScopedRuleIds: readonly string[];
      // Per-loop deduplicated lesson outcome tracker: lessonId -> worst 4-state outcome observed so far
      readonly accumulatedLessonOutcomes: Readonly<Record<string, LessonOutcome>>;
    }
  | {
      readonly kind: 'fork-batch-frame';
      readonly parentStepExecId: string;
      readonly forks: ReadonlyArray<{
        readonly forkId: string;
        readonly callId: string;
        readonly toolName: string;
        readonly activePartitions: readonly string[];
        readonly status: 'RUNNING' | 'CHILD_COMMITTED' | 'COMPLETED' | 'SUSPENDED';
        readonly conflictRetryCount: number;
        readonly conflictCheckArmed: boolean;
        readonly suspensionEpoch: number;
        readonly syncedToParentCheckpoint?: string;
        readonly childScopeCheckpoint?: string;
        readonly committedReceiptJson?: string;
        readonly continuationStack: readonly ContinuationFrame[];
      }>;
    }
  | {
      readonly kind: 'speculate-frame';
      readonly parentStepExecId: string;
      readonly callId: string;
      readonly toolName: string;
      readonly phase: 'RACING' | 'CROSS_VERIFYING' | 'ARBITRATING' | 'REFINING_WINNER' | 'COMMITTING';
      readonly winnerBranchIndex?: number;
      readonly preRefinementCheckpoint?: string;
      readonly activeSubStack?: readonly ContinuationFrame[];
      readonly branches: ReadonlyArray<{
        readonly branchIndex: number;
        readonly forkId: string;
        readonly status:
          | 'RUNNING'
          | 'COMPLETED'
          | 'FAILED'
          | 'PARKED_ON_ESCALATION'
          | 'WINNER_COMMITTED';
        readonly childScopeCheckpoint?: string;
        readonly outputJson?: string;
        readonly scopeReceiptJson?: string;
        readonly errorSummary?: string;
        readonly parkedInterruptId?: string;
        readonly parkedEscalationPayloadJson?: string;
        readonly continuationStack: readonly ContinuationFrame[];
      }>;
      readonly humanRulingsHistory: ReadonlyArray<{
        readonly branchIndex: number;
        readonly interruptId: string;
        readonly rulingSummary: string;
      }>;
      // Buffered per-branch lesson outcomes flushed to LessonStore only for the selected winner
      readonly bufferedLessonOutcomes?: ReadonlyArray<{
        readonly branchIndex: number;
        readonly outcomes: ReadonlyArray<{ readonly lessonId: string; readonly outcome: LessonOutcome }>;
      }>;
    };

export interface SuspendedForkRecord {
  readonly suspendedForkId: string; // Monotonic ID: `${forkId}#${suspensionEpoch}`
  readonly forkId: string;
  readonly suspensionEpoch: number;
  readonly runId: string;
  readonly parentStepExecId: string;
  readonly forkToolName: string;
  readonly activePartitions: readonly string[];
  readonly suspensionReason: 'INTERRUPT_RAISED' | 'PAUSED_BY_SIBLING_INTERRUPT';
  readonly conflictRetryCount: number;
  readonly conflictCheckArmed: boolean;
  readonly syncedToParentCheckpoint?: string;
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
    readonly compiledPrefixesJson?: Readonly<Record<string, string>>; // prefixGroupId -> JSON-serialized CompiledWirePrefix pinned at run start
  }): Promise<{
    readonly status: string;
    readonly currentStepId: string | null;
    readonly inputJson: string;
    readonly rewindPendingToStepId?: string;
    readonly compiledPrefixesJson?: Readonly<Record<string, string>>;
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
  // All updates for a given stepExecId are serialized through a per-step async queue in @harness-dsl/core
  // (including activeLeases / grantedLoopLeases updates and concurrent child fork frame transitions).
  updateContinuationStack(
    runId: string,
    stepExecId: string,
    continuationStack: readonly ContinuationFrame[],
  ): Promise<void>;
  appendMessageFrame(runId: string, frame: WireFrameRecord): Promise<void>;
  replaceMessageFrame(runId: string, frame: WireFrameRecord): Promise<void>;
  markFrameTombstone(runId: string, messageId: string, compactedTombstone: string): Promise<void>;
  getMessageChain(leafMessageId: string): Promise<readonly WireFrameRecord[]>;
  recordForkSuspension(record: SuspendedForkRecord): Promise<void>;
  getSuspendedForks(runId: string, forkIds?: readonly string[]): Promise<readonly SuspendedForkRecord[]>;
  resolveSuspendedFork(suspendedForkId: string, status: 'RESUMED' | 'ABORTED'): Promise<void>;
  recordStepTransition(transition: {
    readonly stepExecId: string;
    readonly status: 'COMPLETED' | 'INTERRUPTED' | 'FAILED' | 'SUSPENDED';
    readonly outputJson?: string;
    readonly headScopeCheckpoint?: string;
    readonly telemetryJson: string;
    readonly pendingToolBatch?: PendingToolBatch;
  }): Promise<void>;
  recordRunTerminalReceipt(
    runId: string,
    itemKey: string,
    terminalState: string,
    scopeReceiptJson?: string,
  ): Promise<void>;
  getRunTerminalReceipts(
    itemKeys: readonly string[],
  ): Promise<ReadonlyMap<string, { readonly runId: string; readonly terminalState: string; readonly scopeReceiptJson?: string }>>;
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
  // Returns the partition graph for runId (merging any uncommitted per-run CoW overlay over the base store)
  getPartitions(runId?: string): Promise<ReadonlyMap<string, TopologyPartitionState>>;
  // Writes contract updates to runId's isolated CoW overlay so concurrent unmerged runs are never polluted
  updateContract(
    runId: string,
    partitionId: string,
    newContractText: string,
  ): Promise<{ readonly newEpoch: number }>;
  // Merges a prerequisite run's overlay (ACTIVE or SEALED_UNMERGED) into a resumed parent run's overlay during syncRoot
  syncRunOverlays(targetRunId: string, prerequisiteRunIds: readonly string[]): Promise<void>;
  // Seals runId's overlay on flow exit 'done' when awaiting an external merge signal (so stacked dependents
  // can merge it via syncRunOverlays without polluting the base store for unrelated main-branched runs)
  sealRunOverlay(runId: string): Promise<void>;
  // Commits runId's overlay to the base store (upon shipped signal or immediate 'done'), or discards it on abort
  commitRunOverlay(runId: string): Promise<void>;
  discardRunOverlay(runId: string): Promise<void>;
}

export type LessonOutcome =
  | 'clean_pass'
  | 'gate_rejected_recovered'
  | 'gate_rejected_unrecovered'
  | 'violated';

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
    readonly requestId: string;
    readonly humanId: string;
    readonly payload: TRequest;
    readonly responseSchema: z.ZodType<TResponse>;
    readonly keepAliveSeconds?: number;
    readonly signal?: AbortSignal;
  }): Promise<TResponse>;
  cancelDecision?(runId: string, requestId: string): Promise<void>;
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

* **`H.signal(id).payload(zodSchema)`:** Asynchronous event emitted by external streams, control-plane adapters, or internal threshold monitors. Signals route to harness notification handlers, topology overlay commit hooks, or ledger compaction hooks without unwinding execution call stacks, *except* when explicitly bound to a lane's `.onSignal(sig, $s => $s.rewindTo(stepId))` handler (which drains in-flight work and rewinds the run to `stepId`).
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

* **Declaration-Order Run-Start Pinning of Wire `system` Field:** For every `H.agent` bound to `.prefixGroup(engineeringPrefix)`, the top-level wire `system` prompt concatenates the group's `.sharedGrounding(...)`, `.sharedInstructions(...)`, and global rules from `.sharedRules(...)` in strict **AST declaration order** (using `Source.digest` only to compute `CompiledWirePrefix.systemDigest`). At the start of each flow run, `@harness-dsl/core` resolves and pins `CompiledWirePrefix` in `LedgerStore` (`createOrResumeRun().compiledPrefixesJson`). If an actor (such as `coordinator`) legitimately mutates a file referenced in `.sharedGrounding()` mid-run (e.g., `TECH_DESIGN.md` or, after an owner lease, `PRODUCT_SPEC.md`), the pinned wire `system` prompt is **never** mutated; instead, the runtime computes the diff between the run-start grounding snapshot and the current working copy and injects that diff into subsequent Turn-0 `[ROLE_AND_SCOPE_CONTEXT]` and `[TOPOLOGY_SYNC]` user frames.
* **Two Wire Tool Modes (`.toolsMode('role-scoped' | 'union')`):**
    * **`'role-scoped'` (Default, paired with `historyMode: 'shared-prefix-only'`):** Each actor transmits only its own declared `.tools()`, `.skills()` tool schemas, and `.capabilities()` tools alongside the shared `systemPromptText`. Because `'shared-prefix-only'` forks start a clean transcript at `messages[0]` and provider caches are content-addressed per `(model_id, tools, system)`, every `sonnet` worker achieves a 100% prefix cache hit across all `sonnet` worker invocations without paying token prefill overhead for—or being tempted to call—`coordinator`-only orchestration tools (`delegate-partition`, `explore-candidates`, `spawnTasks`, `resumeFork`).
    * **`'union'` (Required only when a member actor configures `.fork(..., $f => $f.historyMode('clone-transcript'))` across distinct roles):** At AST compilation time, `@harness-dsl/core` computes the deterministic, byte-identical union of tool schemas across all member actors in the `prefixGroup` (tagging role-restricted tools with a static `[Role: <actorId>]` suffix so `wireToolSchemas` never vary per caller). A child fork cloning the parent's `messages[0..k]` transcript retains 100% byte-identical `tools` and `system` blocks prior to `messages[0]`, while active role permissions are declared in `[ROLE_AND_SCOPE_CONTEXT]` and enforced pre-flight by the runtime role lease gate.
* **Turn-0 `[ROLE_AND_SCOPE_CONTEXT]` Frame:** Actor-specific `.instructions(...)` (such as `coordinator.md` vs `worker.md`), live `H.topology` partition contracts and epochs, in-run grounding diffs, partition-scoped rules, and recalled lessons are never placed in the wire `system` field. Instead, they are injected into the structured `[ROLE_AND_SCOPE_CONTEXT]` user message frame at Turn 0 of the session (`historyMode: 'shared-prefix-only'`) or at the transcript fork point (`historyMode: 'clone-transcript'`).

### 3.2.2 Deterministic Downward Fork Model Routing

Configuring `.modelRouting(($m) => $m.inheritParentWithEffort('medium', { when: (parentInput, toolReq) => boolean }).otherwisePool(pool))` on `.fork()` evaluates the deterministic `when` predicate over `(parentInput, toolReq)` (for example, `req.estimatedTurns <= 6`) to keep short forks on the parent model's weights with reduced reasoning effort while routing longer forks to `pool`.

## 3.3 Relational System Topology (`H.topology`)

`H.topology(id).store(topologyStore).partitions(record).commitOverlayWhen(opts?)` defines the directed graph of logical system partitions.

* **Pure Relational Graph:** Each partition key declares optional `dependsOn: readonly string[]` edges. Core `H.topology` has zero awareness of files or globs; domain packages (such as `@harness-dsl/fs`) map partitions to physical resources externally.
* **Run-Scoped Copy-on-Write Overlay, Signal-Correlated Commit & Turn-0 Injection:** The `TopologyStore` tracks an integer `epoch` and `contractText` per partition. Contract mutations performed via `updatePartitionContract` are written to a per-`runId` Copy-on-Write overlay (`TopologyStore.updateContract(runId, partitionId, newContractText)`) so unmerged contract edits in one active run never pollute concurrent runs executing in parallel across the lane:
    * **Direct-Landing vs. PR-Merged Overlay Lifecycle (`.commitOverlayWhen({ onSignal?: { signal, correlateBy } })`):** When a flow exits `'done'` in a PR-opening lane configured with `.commitOverlayWhen({ onSignal: { signal: changeShippedSignal, correlateBy: (sig) => sig.ref } })`, the runtime transitions the run's overlay to `SEALED_UNMERGED` (`TopologyStore.sealRunOverlay(runId)`). Stacked dependent runs waking via `'prerequisite-exit'` still merge the prerequisite's `SEALED_UNMERGED` overlay via `syncRunOverlays`, while unrelated runs branching from `main` continue reading the clean base `TopologyStore` until `changeShippedSignal` fires and invokes `TopologyStore.commitRunOverlay(runId)`. (For direct-landing flows without an `onSignal` gate, `commitRunOverlay(runId)` executes immediately on flow exit `'done'`.) If a run aborts or exits in a failure state, its overlay is discarded via `discardRunOverlay(runId)`.
    * **Turn-0 & Delta Injection:** When an actor binds `.topology(repoTopology)`, the runtime loads `getPartitions(runId)` and injects the live partition graph, contract texts, and epoch numbers into that actor's Turn-0 `[ROLE_AND_SCOPE_CONTEXT]` frame (and injects `[TOPOLOGY_SYNC]` deltas on `resumeFork`), keeping the `H.prefixGroup` wire `system` prompt completely immutable when contracts advance from Epoch $E$ to $E+1$.
* **Graph Queries:**
    * `topology.dependentsOf(partitionId)` returns all strict transitive dependent partition IDs (e.g., `dependentsOf('db') -> ['api', 'web']`).
    * `topology.affectedBy(partitionId)` returns `[partitionId, ...topology.dependentsOf(partitionId)]` (e.g., `affectedBy('db') -> ['db', 'api', 'web']`), ensuring both the target partition itself and all its transitive dependents are paused when a contract violation targets `partitionId`.

## 3.4 Contextual Knowledge (`H.rules`, `H.skill`, `H.lessons`)

### 3.4.1 Rules (`H.rules` & `H.scopedRule`)

Consumes inline rule objects, `Source` adapters (`GlobalRuleSchema`, `ScopedRuleSchema`), or fluent `H.scopedRule(idOrSource)` builders.

* **`.global(...MaybeSource<GlobalRule | GlobalRule[]>[])`:** Resolved at session start and pinned in the static system prompt prefix (or `H.prefixGroup`).
* **`.scoped(...MaybeSource<ScopedRule | ScopedRule[]>[])` & `H.scopedRule(idOrSource)`:** Constructed via `H.scopedRule(id).when({ partitions?: string[], effects?: EffectMatcher }).directive(maybeSourceString).enforceBeforeStop(...Check[])` (or by wrapping a frontmatter-loaded `Source<ScopedRule>` as `H.scopedRule(md.scopedRule(path)).enforceBeforeStop(...Check[])`). The runtime tracks `observedEffects` and `injectedScopedRuleIds` in `agent-frame` (and carries them across `loop-frame` iterations):
    * **Pre-Flight Injection:** Injected into the initial `[ROLE_AND_SCOPE_CONTEXT]` frame if the task's `activePartitions` (extracted via `.partitions()`) intersect `when.partitions`, recording `rule.id` in `injectedScopedRuleIds`.
    * **Deduplicated Reactive Effect Injection:** Injected into the `tool_result` frame the first time an agent invokes a tool whose `ToolEffect` matches `when.effects` **and** `rule.id` is not already in `injectedScopedRuleIds` (recording `rule.id` in `injectedScopedRuleIds` so pre-flight-injected rules are never injected a second time).
    * **Crash-Safe Gate Enforcement:** Runs attached `Check` instances during the actor's `beforeStop` gate whenever `rule.id` is in `injectedScopedRuleIds` and at least one scope-mutating effect (`effect.mutatesScope === true`) was recorded in `observedEffects` during the session or enclosing loop.

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

Constructed via `H.skill(idOrSource).when({ partitions?: string[], effects?: EffectMatcher }).description(text).instructions(maybeSourceString).unlocksTools(...ToolDefinition[]).unlocksServices(...Service[]).lease('until-completed-or-fork-exit')`. Encapsulates on-demand procedural instructions, tools, and services without busting the LLM provider's prompt prefix cache or invalidating cryptographic thinking signatures:

* **Static Wire Tool Registration with Lease Gating:** When an `H.agent` is initialized with `.skills(...)`, all tool schemas from `.unlocksTools(...ToolDefinition[])` and `.unlocksServices(...Service[])` (`Service.toolSchemas`) are registered in that actor's wire-level `tools` array from Turn 0 with `[Requires active skill: <id>]` appended to their description (and when `.when(...)` is configured on the skill, the skill is highlighted in `[ROLE_AND_SCOPE_CONTEXT]` or reactive `tool_result` notes when matching partitions or effects are encountered). The wire `tools` array never mutates mid-session. If an agent invokes a skill-gated tool while the skill is inactive (`!<agentFrame>.activeSkillIds.includes(id)`), the runtime blocks the call pre-flight and returns an `isError: true` tool result instructing the agent to call `activateSkill(id)` first.
* **Skill Activation (`activateSkill(id)`) & Automatic Suspension Quiescing:** Resolves instructions (`MaybeSource<string>`), acquires all `.unlocksServices(...Service[])` sessions for the active `scopeHandle`, records `id` in `agent-frame.activeSkillIds`, grants an execution lease for the skill's tools, and returns the skill instructions in the `tool_result` frame. Whenever an active fork or run enters a suspended or parked state (`SuspendedForkRecord`, `PARKED_ON_ESCALATION`, or `suspend-and-yield-slot`), the runtime automatically stops active `ServiceSession` daemons (releasing OS `maxDaemons` slots and ephemeral TCP ports). Upon `resumeFork`, unparking, run wakeup, or process crash recovery, the runtime transparently re-acquires all services for skills listed in `agent-frame.activeSkillIds` and appends `[SERVICE_REACQUIRED: <serviceId> restarted on new port(s); in-memory session state reset]` to the resuming `tool_result` frame via `ModelDriver.appendToolResultNotes`.
* **Skill Completion (`completeSkill(id)`) & Cross-Model-Only Tombstone Substitution:** Under `.lease('until-completed-or-fork-exit')`, calling `completeSkill(id)`:
    * Immediately stops and unmounts all acquired `ServiceSession` instances (freeing OS daemon slots and ports), removes `id` from `agent-frame.activeSkillIds`, and revokes the active execution lease for the skill's tools.
    * Calls `LedgerStore.markFrameTombstone(runId, activateMsgId, "[Skill '<id>' completed and unmounted]")` on the earlier `activateSkill` `WireFrameRecord`.
    * **Same-Model Preservation (Including Same-Model `clone-transcript` Forks):** Throughout the active session, across same-model preserved-session `H.loop` iterations, and across same-model `clone-transcript` forks (`sourceModelId === targetModelId`), `rawWireFrame` is transmitted untouched (`substituteTombstones: false`) so the provider's KV prefix cache remains 100% intact and all subsequent `thinking` / encrypted reasoning blocks retain valid cryptographic signatures.
    * **Cross-Model Escalation Substitution (`sourceModelId !== targetModelId`):** Whenever `ModelDriver.prepareFork()` synthesizes a message chain for a cross-model escalation (`M_1 != M_2`, where provider KV caches and model-specific thinking signatures do not transfer, `substituteTombstones: true`), it substitutes `compactedTombstone` in place of the bulky instruction payload.

### 3.4.3 Lessons (`H.lessons`) & Deduplicated Per-Execution Attribution

Backed by any `LessonStore` adapter. Because high-leverage preventative lessons (negative constraints such as *"Never use X because of Y"*) are obeyed silently across multi-turn sessions, `@harness-dsl/core` uses objective 4-state execution evidence (`clean_pass`, `gate_rejected_recovered`, `gate_rejected_unrecovered`, `violated`) rather than worker self-citation:

* **Typed Query Extraction (`.queryFrom(inputSchema, (input) => queryText)`):** Extracts a deterministic search query string from the actor's validated input `TIn` (falling back to `JSON.stringify(input)` if omitted) and passes `{ queryText, partitions: ctx.activePartitions }` to `LessonStore.queryCandidates()`.
* **Contrastive Distillation with Noise Filtering (`.onLoopRecovery()` & `.onGateRecovery({ minFailedChecks?: number })`):**
    * **Outer Loop Recovery (`.onLoopRecovery()`):** Triggered when Iteration $k$ of an `H.loop` fails evaluation and Iteration $k + n$ ($n \ge 1$) succeeds. The distiller agent receives `{ source: 'loop', rejected: { output, scopeReceipt, deficits }, accepted: { output, scopeReceipt } }`.
    * **In-Session Gate Recovery (`.onGateRecovery()`):** Triggered asynchronously (off the critical execution path) when an `H.agent` fails `beforeStop` checks on completion attempt $a$ (with at least `minFailedChecks`, default 1) and subsequently passes all `beforeStop` checks on attempt $a + m$ ($m \ge 1$) within the same session. The distiller agent receives `{ source: 'gate', rejected: { output, failedChecks, deficits }, accepted: { output, scopeReceipt } }`.
    * **Non-Generalizable Noise Filter (`admit: boolean`):** The distiller agent's structured output conforms to `DistilledLessonCandidate` (`{ admit: boolean, partition?: string, directive?: string }`). If a `beforeStop` or loop failure was caused by a one-off typo or transient mistake rather than a reusable architectural invariant, the distiller returns `{ admit: false }` and no lesson is written to `LessonStore`.
* **Deduplicated Per-Execution Outcome Attribution (`1 outcome per (stepExecId, lessonId)`) & Winner-Only Speculative Flush:**
    * To prevent a multi-iteration `H.loop` on a single pathological task from recording multiple violations for the same lesson and prematurely retiring it, lesson outcomes are accumulated in `ContinuationFrame.accumulatedLessonOutcomes` across the lifetime of the top-level `H.loop` (or standalone `H.agent`) and flushed **once** to `LessonStore.recordOutcomes()` when the step reaches a terminal transition (and inside `.speculate()`, buffered per branch in `speculate-frame.bufferedLessonOutcomes` so only the selected winning branch flushes to `LessonStore`, discarding losing/aborted branches), governed by the strict 4-state precedence order:

$$\texttt{violated} \succ \texttt{gate\_rejected\_unrecovered} \succ \texttt{gate\_rejected\_recovered} \succ \texttt{clean\_pass}$$

* **Active Evaluator Violation (`'violated'`):** When an `H.loop` is configured with `.distillLessonsInto(lessons)`, the runtime forwards the exact active lesson list recalled for the `.act()` actor directly into the `.evaluate()` actor's context (without re-querying `LessonStore` against the evaluator's wrapper input schema) and augments the evaluator's wire output schema with `_harnessMeta: { violatedLessonIds: string[] }` (stripped before returning the domain evaluation output). If a recalled lesson is listed in `violatedLessonIds` on *any* rejected iteration of the loop (or if the loop exhausts `maxIterations` after a violation), that lesson's terminal outcome for the loop execution is `'violated'` (counted once).
* **Friction Without Violation (`'gate_rejected_recovered'` vs. `'gate_rejected_unrecovered'`):** Any injected lesson that never recorded `'violated'` during a session that experienced at least one real `beforeStop` check failure or `H.loop` evaluation rejection records `'gate_rejected_recovered'` if the loop/gate subsequently succeeded, or `'gate_rejected_unrecovered'` if the step exhausted `maxIterations` without passing. (Neutral `[TOPOLOGY_SYNC_REVERIFY]` continuations after a sibling pause never count as a `beforeStop` failure, and if a step aborts via a fast-path `scopeTripwire` or `contractViolation` *before* the worker ever attempts `beforeStop` completion, zero lesson outcomes are recorded for that aborted reconnaissance attempt.)
* **Silent Preventative Success (`'clean_pass'`):** Whenever an actor session passes all `beforeStop` checks on its first real completion attempt and (if inside an `H.loop`) is accepted by the evaluator on Iteration 0 with zero violations, all lessons injected into that session record a single `'clean_pass'` outcome.
* **Scoring Formula:** Given query $Q$, active partitions $P$, current partition epoch $E_{\text{now}} = \text{partitions.get}(L.\text{partition})?.\text{epoch} ?? 0$, creation epoch $E_0$ (where $E_{\text{now}} = E_0 = 0$ when $L.\text{partition}$ is `undefined`), and sliding window $W$ of the last $K$ deduplicated step executions ($c_W$ `clean_pass`, $g_W = g_W^{\text{recovered}} + g_W^{\text{unrecovered}}$ total gate-rejected, $v_W$ `violated`, where $c_W + g_W + v_W = |W| \le K$):

$$\text{Score}(L, Q) = R(L, Q) \cdot (1 + \beta \cdot \mathbb{I}(L.\text{partition} \in P)) \cdot \gamma^{(E_{\text{now}} - E_0)} \cdot \left(\frac{c_W + 1}{c_W + 2v_W + 0.5g_W + 2}\right)$$

where $\beta$ is `partitionMatchBoost` and $\gamma \in (0, 1]$ is `decayOnPartitionEpochChange`.

* **Retirement & Promotion Signals:**
    * `.retireAfter(($r) => $r.maxViolations(v).orMinCleanPassRate(minRate, { afterInjections: m }))` retires any lesson that accumulates $v$ deduplicated task violations or whose effective non-recovered clean-pass ratio $\frac{c_W}{c_W + v_W + g_W^{\text{unrecovered}}}$ falls below `minRate` after at least $m$ injections (excluding `gate_rejected_recovered` sessions that succeeded in-loop without violating $L$ so multi-iteration tasks do not evict obeyed lessons).
    * `.emitSignalWhen(signal, ($t) => $t.minCleanPasses(c).maxViolations(v).cooldownHours(h), (lesson: LessonRecord) => TPayload)` projects a qualifying `LessonRecord` via the pure synchronous payload mapper and emits `signal` so high-leverage empirical lessons can be promoted into permanent `H.rules` or deterministic `H.check` gates.

## 3.5 Capability Policies (`H.policy`), Deterministic Post-Flight Scope Diffing & Turn-Batched Suspended Tool Replay

`H.policy(id)` enforces deterministic sandbox guards, default abort hooks (`.onAbort(abortHook)`), and quantitative tripwires over an `H.agent`. Calling `basePolicy.extend(newId)` returns a derived `H.policy` that inherits the base policy's guards, `.onViolation()` handler, tripwires, and `.onAbort()` hook while adding or overriding limits:

* **Two-Phase Effect Guard Enforcement (`.guard(...PolicyGuard[]).onViolation(...)`):**
    * **Violation Modes:**
        1. **`.onViolation('raise-interrupt', interrupt, (violation) => intrPayload)`:** Requires a pure synchronous mapper projecting `{ blockedCalls: readonly PendingPreFlightCall[], violatedEffects: readonly ToolEffect[], violationSummary: string }` into `interrupt.schema` so deterministic guard failures always produce a schema-valid interrupt payload without requiring an extra LLM generation turn.
        2. **`.onViolation('deny-with-error', messageMapper?)`:** Blocks the unauthorized tool call(s) in-band and returns an `isError: true` `tool_result` frame instructing the actor to either delegate the operation or invoke its voluntary `.escalate(...)` capability tool with an LLM-authored decision brief.
    * **Sequential Intra-Turn Execution & Pre-Flight `PendingToolBatch` Capture:** When an assistant turn emits tool calls `(1..k)`, the runtime processes them sequentially in declaration order `(1..k)`, evaluating each call's pre-flight guard (against the union of `agent-frame.activeLeases`, `loop-frame.grantedLoopLeases`, and `agent-frame.activeSkillIds`—supporting intra-turn `activateSkill(id)` followed immediately by a tool unlocked by `id`) right before executing that call:
        * If call $i$ defines `tool.describeEffects(args, scopeHandle)` and is disallowed under `.onViolation('raise-interrupt', interrupt, mapper)`, the runtime stops executing further tools in the turn, collects call $i$ and any subsequent calls in `(i+1..k)` that also fail pre-flight with static `describeEffects` into `pendingToolBatch.blockedCalls`, places all remaining calls into `pendingToolBatch.unstartedCalls`, persists `agent-frame.pendingToolBatch = { completedResults, blockedCalls, unstartedCalls }`, and raises a single batched `interrupt` via `mapper(violation)`.
    * **Mandatory Post-Flight Check & Scope-Diff Rollback for Code-Executing / Subprocess Tools (Requires `CheckpointableScope`):** Any tool that executes arbitrary code or subprocesses inside the workspace (such as `local.command.asTool()` or `local.streamCheck.asTool()`, including `verifySuite.asTool()`) MUST omit `describeEffects`. If an actor mounts any tool that omits `describeEffects` under an active `PolicyGuard`, the AST compiler verifies that the enclosing flow's `IsolationScope` implements `CheckpointableScope`:
        * Immediately before invoking call $i$, the runtime snapshots the scoped uncommitted state via `const preToolCkpt = await scope.serializeCheckpoint(scopeHandle)`.
        * Immediately after `tool.execute()` completes, the runtime computes `const synthesizedEffects = await scope.diffEffects(preToolCkpt, scopeHandle)` and evaluates `PolicyGuard.evaluate()` **before** recording the effects in `ctx.recordEffects()`.
        * If `PolicyGuard.evaluate()` returns `allowed: true`, the runtime records `ctx.recordEffects(synthesizedEffects)` and appends the result to `completedResults`.
        * If `PolicyGuard.evaluate()` returns `allowed: false` (for example, a newly created test file attempting to write to `packages/db/src/index.ts` or an existing `*.test.ts` file during `verifySuite.asTool()`), the runtime calls `await scope.restoreCheckpoint(scopeHandle, preToolCkpt)` to roll back the unauthorized delta (never recording the rolled-back effects in `observedEffects`), appends `{ callId: call_i.id, content: "[Post-Flight Policy Violation — Workspace Rolled Back: ${violationSummary}]", isError: true }` to `pendingToolBatch.completedResults`, places any remaining calls `(i+1..k)` into `pendingToolBatch.unstartedCalls`, and raises `interrupt` via `mapper(violation)` (never re-executing the rolled-back subprocess call on `.resumeWith()`).
    * **Turn-Batched Tool Replay & Sequential `unstartedCalls` Drain on `.resumeWith(feedback)`:** When an interrupt raised by a pre-flight or post-flight `PolicyGuard` is adjudicated via `.onInterrupt()` and resumes via `.resumeWith(feedback)`:
        1. If `.elevateLeaseWhen()` granted a `LeaseDelta`, the runtime adds the lease to both `agent-frame.activeLeases` and any enclosing `loop-frame.grantedLoopLeases` (persisted via the serialized per-step `updateContinuationStack` queue).
        2. For each pre-flight call in `pendingToolBatch.blockedCalls`, the runtime re-evaluates `PolicyGuard.evaluate()`: any call now `allowed: true` is **executed immediately via `tool.execute(args, ctx)`** without requiring the LLM to regenerate the tool call, producing `[Lease Elevated: ${feedback}]\n\n${toolResult.content}` in `completedResults`; any call still disallowed receives `[Lease Denied: ${feedback}]` (`isError: true`) in `completedResults`. (If the interrupt was triggered by a post-flight rollback, the rolled-back call's error entry in `completedResults` has `\n[Adjudication: ${feedback}]` appended.)
        3. Regardless of whether the lease was approved or denied, the runtime then sequentially evaluates and executes all remaining calls in `pendingToolBatch.unstartedCalls` using the same pre-flight/post-flight loop (raising a new interrupt if a subsequent call violates policy, or clearing `pendingToolBatch` and appending a single complete `tool_result` frame covering every `callId` `1..k` in the assistant turn).
* **Quantitative Tripwires:**
    * Universal LLM loop tripwires: `.maxTurns(n)`, `.maxCostUsd(n)`, `.maxDurationSeconds(n)`.
    * Domain quota tripwires: `.tripwire(...QuotaTripwire[])` (e.g., `fs.maxFilesMutated(4)` from `@harness-dsl/fs`) evaluated post-flight after each allowed tool execution.
* **Limit Exceeded State-Machine Sequence (`.onLimitExceeded($l => ...)`):** When any turn, cost, duration, or `QuotaTripwire` threshold is breached, the runtime executes the following sequence in strict order:
    1. **Complete Trailing Wire Frame:** If the threshold was breached during a multi-tool assistant turn while `unstartedCalls` remain, the runtime synthesizes `{ callId, content: '[Aborted: Limit Exceeded]', isError: true }` for each unstarted call and appends the complete `tool_result` frame so every `tool_use` block in the assistant turn is paired.
    2. **KV-Cache-Preserving Epistemic Flush (`.flushWithInterrupt(interrupt)`):** While the `scopeHandle` is still intact, the runtime attaches the `[LIMIT_EXCEEDED_FLUSH]` directive to the trailing `tool_result` frame via `ModelDriver.appendToolResultNotes` (or appends a single `user` frame if the limit was reached after a tool-less `assistant` turn) and invokes a single final turn (`maxTurns: 1`) via `ModelDriver.invokeTurn` with `toolChoice: 'none'`, `effort: 'low'`, and `outputSchema: interrupt.schema` while keeping `wirePrefix` (`wireToolSchemas`) intact—preserving a 100% provider KV prefix cache hit for the flush turn while preventing any further tool calls.
    3. **Scope Abort Hook (`.onAbort(abortHook)`):** After the flush turn completes, the runtime executes `const abortMeta = await abortHook.execute(scopeHandle, runId)` (or the policy-level `.onAbort(abortHook)` if configured) and attaches `abortMeta` to `stepTelemetry.abortMeta`.
    4. **Interrupt Routing:** The runtime transitions the step to `INTERRUPTED` and transfers control to the enclosing `.onInterrupt(interrupt)` handler with `(flowInput, intrPayload, stepTelemetry)`.

## 3.6 Humans (`H.human`)

`H.human(id).keepAliveSeconds(n).notify(humanAdapter)` represents an external human decision authority invoked declaratively via `.ask(human, responseSchema)`, `.escalate()`, or `H.lane.maxCostUsd(limit, human.withName(alias).output(H.BudgetApprovalSchema))`. Calling `human.withName(alias).output(responseSchema)` returns a scoped human decision target bound to `responseSchema`.

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

Capabilities that branch scope handles (`.fork()`, `.speculate()`, and `.mutatePlan()` with `suspend-and-yield-slot`) require the enclosing flow's `IsolationScope` to implement `BranchableScope`. To prevent concurrent child forks from racing on a shared `parentHandle` without serializing read-only operations, `@harness-dsl/core` maintains an asynchronous Read/Write lock per `scopeHandle` (`ScopeLockManager`) and a single serialized async write queue per `stepExecId` for `LedgerStore.updateContinuationStack`:

* **Shared Read Lock (`acquireRead`):** Acquired by `forkChild`, `inspect`, and parent tool executions whose `describeEffects` return only non-mutating effects (`effect.mutatesScope !== true`, or `[]`), allowing multiple child forks and speculative branches to clone from `parentHandle` concurrently.
* **Exclusive Write Lock (`acquireWrite`):** Acquired by operations that mutate or reconcile `parentHandle` (`commitChild`, `syncChild`, `syncRoot`, and parent tools whose `describeEffects` include `mutatesScope: true` or omit `describeEffects`). Child forks execute concurrently against their own isolated `childHandle` without holding locks on `parentHandle`.
* **Per-Step Serialized `updateContinuationStack` Queue:** All mutations to the active step's `ContinuationFrame[]` tree (including concurrent child forks updating their entries in `'fork-batch-frame'`, speculative branches updating `'speculate-frame'`, and lease/effect/lesson accumulators) are serialized through a per-`stepExecId` in-memory async mutex before calling `LedgerStore.updateContinuationStack(runId, stepExecId, continuationStack)` so concurrent sibling transitions never overwrite each other.

**Capability 1 — Downward Forking (`.fork(toolName, childExecutable, $f => ...)`):**

* Exposes a tool call validated by `.requestSchema(zod)` and projected to the child's input via `.mapInput((parentInput, toolReq) => childInput)`.
* **History Mode (`.historyMode('shared-prefix-only' | 'clone-transcript')`, default `'shared-prefix-only'`):**
    * Under `'shared-prefix-only'` (default), the child actor shares the compiled `H.prefixGroup` `systemPromptText` alongside its own role-scoped wire `tools` array (`toolsMode: 'role-scoped'`) and starts at `messages[0]` with its own clean `[ROLE_AND_SCOPE_CONTEXT]` + mapped task prompt—preventing parent transcript noise, parent orchestration tool schemas, or parent mid-session skill tombstones from polluting the child.
    * Under `'clone-transcript'` (which requires `H.prefixGroup.toolsMode('union')` if parent and child have different toolsets), `ModelDriver.prepareFork()` clones `parentChain` up to `forkPointMessageId` (with `substituteTombstones: sourceModelId !== targetModelId`, preserving same-model KV cache hits and thinking signatures) and appends the child's `[ROLE_AND_SCOPE_CONTEXT]` frame.
* Acquires a shared read lock on `parentHandle` to fork a child scope handle (`BranchableScope.forkChild`), records an active `'fork-batch-frame'` entry in the parent's `ContinuationFrame[]` stack, and executes `childExecutable` inside `childHandle` while keeping the child's nested `ContinuationFrame[]` stack (`loop-frame` -> `agent-frame` with `preservedActLeafMessageId`) live until `commitChild` succeeds.
* **Idempotent Zero-Pollution Conflict-Bounce Reconciliation:** Upon child completion, the runtime acquires the exclusive write lock on `parentHandle` and invokes `const res = await scope.commitChild(childHandle, parentHandle)`:
    * If `res.status === 'clean'`, the runtime records `status: 'CHILD_COMMITTED'` with `committedReceiptJson` on the `'fork-batch-frame'` in `LedgerStore` *before* releasing the lock and calling `scope.release(childHandle)` (making crash recovery idempotent if the process restarts between `commitChild` and parent turn resumption), then returns `{ status: 'COMPLETED', output: childOutput, scopeReceipt: res.data }` as the `tool_result` to the parent, discarding all intermediate child turns from the parent's context window.
    * If `res.status === 'conflict'` (because `parentHandle` advanced while the child was running), `commitChild` leaves `parentHandle` untouched and places the rebased conflict state inside `childHandle`. The runtime releases the write lock on `parentHandle`, increments `conflictRetryCount` and sets `conflictCheckArmed: true` on the `'fork-batch-frame'` entry, rolls the child's enclosing `loop-frame` back to `phase: 'act'` at `preservedActLeafMessageId`, appends a `[COMMIT_CONFLICT]` turn (`res.conflictedSummary`) to the child's inner actor session, re-runs the child (including `conflictCleanCheck`, all `beforeStop` checks, and any enclosing `H.loop` evaluator step), and re-attempts `commitChild` (up to 2 conflict-repair retries before failing the fork).

**Capability 2 — Speculative Execution Tournament (`.speculate(toolName, $s => ...)`) with Non-Destructive Contested Escalation Arbitration:**

* Exposes a tool call validated by `.requestSchema(zod)`.
* Forks $B$ parallel child scope handles (`BranchableScope.forkChild` under shared read locks), records an active `'speculate-frame'` (`phase: 'RACING'`) in `ContinuationFrame[]`, and executes `.worker(actorOrLoop)` across the $B$ inputs mapped by `.branches(B, (parentInput, toolReq) => [input0, input1, ...])`, buffering per-branch lesson outcomes in `speculate-frame.bufferedLessonOutcomes`.
* **Escalation & Upward Interrupt Parking Barrier (`PARKED_ON_ESCALATION`):**
    * While executing inside a speculative branch, endogenous interrupt adjudications handled within the branch (such as `guardedWorker` raising `leaseRequest` to the read-only `leaseAdjudicator` LLM) execute immediately in-branch.
    * If any branch attempts to cross an **exogenous human boundary** (invoking `.ask(human, ...)` or `.escalate(...)` to an `H.human` authority, either directly or via a nested adjudicator raising `normativeEscalation`) **or** raises an unhandled upward interrupt (such as `contractViolation` not caught inside the branch), the tournament supervisor **intercepts and parks** that branch (`status: 'PARKED_ON_ESCALATION'`) without paging the human or aborting sibling branches, quiescing any active `ServiceSession` daemons, capturing its partial `scopeReceipt` (`scope.inspect(childHandle)`) and the structured interrupt/escalation payload while keeping its `childHandle` and `ContinuationFrame[]` stack intact in `'speculate-frame'`.
* **Post-Race Resolution & Non-Destructive Contested Escalation Protection:** Once all $B$ branches reach `COMPLETED`, `FAILED`, or `PARKED_ON_ESCALATION`:
    * **Case 1 — Zero Surviving or Parked Branches (`0 COMPLETED`, `0 PARKED_ON_ESCALATION`):** Releases all child handles and propagates an aggregate branch execution error.
    * **Case 2 — All Non-Failed Branches Parked on Escalation (`0 COMPLETED`, $\ge 1$ `PARKED_ON_ESCALATION`):** If any branch is parked on an exogenous `H.human` escalation, the runtime unparks the branch(es), awaits the human owner's decision, **records each ruling in `humanRulingsHistory`**, resumes execution until each unparked branch reaches `COMPLETED`, `FAILED`, or parks again, and re-enters post-race resolution. If all parked branches are parked on an unhandled upward interrupt (e.g., `contractViolation`) with zero `COMPLETED` branches, the runtime releases all child handles and propagates the upward interrupt to the parent coordinator.
    * **Case 3 — Uncontested Single Survivor (`1 COMPLETED`, `0 PARKED_ON_ESCALATION`, `humanRulingsHistory.length === 0`, remaining branches `FAILED` on endogenous errors):** Short-circuits `.crossVerifyWith()` and `.arbiter()`. If `.verifyWinnerWith(evaluator, opts)` is configured on `.speculate()`, the runtime runs `evaluator` once on the sole survivor before committing; otherwise it flushes `bufferedLessonOutcomes` for the sole winner, commits `soleWinnerHandle` directly into `parentHandle` via `commitChild`, releases all child handles, and returns `{ output: soleWinnerOutput, scopeReceipt, shortCircuited: true }`. (If `humanRulingsHistory.length > 0`—meaning a previously unparked sibling subsequently failed—the tournament **does not short-circuit** and instead enters Case 4 so `.arbiter()` can verify the sole survivor against `humanRulingsHistory` and `failedBranches`.)
    * **Case 4 — Multiple Completed Survivors, Contested Escalation, or Post-Ruling Verification ($\ge 2$ `COMPLETED`, OR $\ge 1$ `COMPLETED` alongside $\ge 1$ `PARKED_ON_ESCALATION`, OR `1 COMPLETED` with `humanRulingsHistory.length > 0`):**
        * The tournament **NEVER short-circuits arbitration when a sibling branch is parked on an escalation or after a human ruling**, preventing a branch that quietly hacked around a spec/test/contract contradiction from automatically silencing a sibling branch that legitimately flagged the contradiction.
        * The runtime transitions `'speculate-frame'` to `phase: 'CROSS_VERIFYING'`, inspects all `COMPLETED` and `PARKED_ON_ESCALATION` branches, runs `.crossVerifyWith(crossVerifier)` across the `COMPLETED` candidates, and transitions to `phase: 'ARBITRATING'` (tracking the arbiter's execution in `activeSubStack`) to invoke `.arbiter(arbiterAgent, { resolveDecision: (verdict) => ... })` with input matching `H.SpeculationInputSchema`:

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
      status: z.literal('PARKED_ON_ESCALATION'),
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
    failedBranches: z
      .array(
        z.object({
          branchIndex: z.number(),
          errorSummary: z.string(),
        }),
      )
      .default([]),
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

* **Arbiter Verdict Resolution (`select-winner` vs `unpark-escalation` vs `reject-all`):**
    * **`decision: 'select-winner'`:** The arbiter selects one of the `COMPLETED` branches (`winnerBranchIndex`). If `.refineWinnerWhen(pred, refinementExecutable, mapper)` matches the verdict, the runtime transitions `'speculate-frame'` to `phase: 'REFINING_WINNER'`, snapshots `preRefinementCheckpoint` on the winning handle, and runs `refinementExecutable` on the winning handle (persisting `activeSubStack`) **while keeping losing candidate worktrees alive** so `git.candidateComparisonTools` (`evalInCandidates`, `diffCandidates`, `readCandidateFile`) remain usable during refinement. Once refinement finishes (or immediately if no refinement is needed), the runtime transitions to `phase: 'COMMITTING'`, releases all losing/parked `childHandle`s, flushes `bufferedLessonOutcomes` for `winnerBranchIndex` only to `LessonStore`, reconciles the winning handle into `parentHandle` via `commitChild`, records `status: 'WINNER_COMMITTED'` in `'speculate-frame'`, and releases the winning child handle.
    * **`decision: 'unpark-escalation'` (Non-Destructive Unparking):**
        * If the selected parked branch (`parkedBranchIndex`) was parked on an exogenous `H.human` escalation (e.g., `normativeEscalation`):
            1. The runtime **retains all already-`COMPLETED` sibling branch handles alive in memory/disk** (never discarding a working candidate prematurely in case the human rules in favor of existing behavior or the unparked branch subsequently fails).
            2. The runtime unparks `parkedBranchIndex`, forwards its pending escalation request to the `H.human` authority, records the ruling in `humanRulingsHistory`, re-acquires any quiesced services, and resumes `parkedBranchIndex` until it transitions to `COMPLETED`, `FAILED`, or parks on a subsequent escalation.
            3. The tournament then re-runs `.crossVerifyWith()` and `.arbiter()` over the updated candidate set (now including the human's ruling in `humanRulingsHistory` and any `failedBranches`) to resolve the final verdict.
        * If the selected parked branch was parked on an unhandled upward interrupt (e.g., `contractViolation`), the runtime aborts and releases all tournament branch handles and propagates that upward interrupt to the parent coordinator.
    * **`decision: 'reject-all'`:** If none of the surviving candidates satisfy the specification or the human owner's ruling in `humanRulingsHistory`, the arbiter returns `decision: 'reject-all'` with `rationale`, releasing all candidate handles (discarding all `bufferedLessonOutcomes`) and returning an `isError: true` tournament rejection result to the parent actor.

**Capability 3 — Dynamic Plan Mutation (`.mutatePlan($m => ...)`) with Prerequisite Priority Boost:**

* `.canSpawnTasks(itemSchema, { maxSpawnedPerRun, maxPrerequisiteDepth?: number, enforcePatch, onPrerequisiteSpawned: 'suspend-and-yield-slot', priorityStrategy?: 'inherit-parent-with-boost' | 'normal', resumeWhen?: 'prerequisite-exit' | { signal: Signal<TPayload>; correlateBy: (sig: TPayload) => string } })`: Mounts a `spawnTasks` tool that enqueues new independent work items into the enclosing `H.lane`.
    * **Slot-Livelock Prevention & Atomic Cycle/Depth Validation:** Same-lane prerequisite spawning always requires `onPrerequisiteSpawned: 'suspend-and-yield-slot'` and enforces `maxPrerequisiteDepth` (default `3`) and DAG acyclicity atomically inside `LedgerStore` so active parent runs never deadlock all lane concurrency slots waiting on unscheduled children.
    * **Head-of-Line Prerequisite Priority Inheritance (`priorityStrategy: 'inherit-parent-with-boost'`, default):** When an active run spawns a prerequisite task and suspends via `'suspend-and-yield-slot'`, the runtime quiesces any active `ServiceSession` daemons and the spawned prerequisite automatically inherits the parent's effective aged priority plus a prerequisite head-of-line boost so it schedules ahead of unstarted external tracker tickets at the same priority tier.
    * **Wakeup on Prerequisite Completion or Failure:**
        * When all spawned prerequisites exit in a success terminal state (`'done'`) and satisfy `resumeWhen` (defaulting to `'prerequisite-exit'`), the runtime loads the prerequisite runs' terminal `TReceipt`s via `LedgerStore.getRunTerminalReceipts`, merges their topology overlays via `TopologyStore.syncRunOverlays`, invokes `BranchableScope.syncRoot(parentRootHandle, prereqReceipts)`, synthesizes a `[PREREQUISITE_SYNC]` (or `[PREREQUISITE_SYNC_CONFLICT]` if `status === 'conflict'`) note on the `spawnTasks` `tool_result` frame via `ModelDriver.appendToolResultNotes` + `LedgerStore.replaceMessageFrame`, and re-acquires a lane concurrency slot to resume the parent.
        * If any spawned prerequisite exits in a non-success terminal state (`'abandoned'`, `'exhausted'`, `'cancelled'`), the suspended parent run wakes up once it re-acquires a lane concurrency slot, skips `syncRunOverlays` and `syncRoot`, and appends `[PREREQUISITE_FAILED: Task <key> exited with '<state>']` (`isError: true`) to the `spawnTasks` `tool_result` frame via `ModelDriver.appendToolResultNotes` so the parent coordinator can replan or escalate rather than hanging indefinitely.
* `.canAddDependencies()`: Mounts an `addDependencies` tool to insert directed edges in the active lane (validated atomically in `LedgerStore` for DAG acyclicity).
* `.canUpdateTopologyContracts(topology)`: Mounts an `updatePartitionContract` tool that updates the current run's CoW overlay in `TopologyStore` and increments the partition's epoch.

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

* **Turn-Batch Barrier, Child Continuation-Stack Suspension & Deterministic Sibling Pause Classification:**
    * When a downward child fork raises `interrupt` (e.g., `contractViolation` targeting partition `'db'`), the runtime stops any active `ServiceSession` daemons in that fork, increments its `suspensionEpoch` (minting monotonic `suspendedForkId = "${forkId}#${suspensionEpoch}"`), and serializes its full `ContinuationFrame[]` stack (preserving any outer `loop-frame` such as `verifiedWorkerLoop` alongside the inner `agent-frame` of `guardedWorker`) into `LedgerStore.recordForkSuspension(...)` with `suspensionReason: 'INTERRUPT_RAISED'`.
    * The runtime signals all sibling forks in `.pauseSiblingForksInPartitions((v) => repoTopology.affectedBy(v.partition))` and waits at the parent turn-batch barrier for all in-flight siblings in the batch to settle before assembling `pausedSiblingForkIds` and `alreadyCommittedSiblingForks`:
        1. **Sibling Executing an LLM Turn, Tool Call, or Inner Endogenous Adjudication:** The runtime lets the sibling's current turn or inner endogenous adjudication (e.g., `leaseAdjudicator`) finish. If the sibling itself raised an upward interrupt on that turn, it is classified independently as `SUSPENDED_ON_INTERRUPT` (`suspensionReason: 'INTERRUPT_RAISED'`). Otherwise, if its trailing message is a completed `tool_result` frame (after canceling any unstarted sibling-internal tool calls in that turn with `[Paused by sibling interrupt]`), the runtime stops active `ServiceSession` daemons and records `pausedAtPhase: 'TOOL_BOUNDARY'` (Case B); if its trailing message is a final structured-output `assistant` turn with zero `tool_use` blocks, the runtime records `pausedAtPhase: 'BEFORE_STOP_GATE'` (Case C).
        2. **Sibling Inside `beforeStop` Checks, Inside `H.loop.evaluate` (`evaluator`), or Awaiting/Retrying `commitChild`:** Because the sibling worker already emitted its final structured output `assistant` turn, its trailing message frame has no `tool_result` block. The runtime aborts the in-flight `beforeStop` check or `evaluator` session, pops the `evaluator` `agent-frame` (if present), stops any active `ServiceSession` daemons, rolls the enclosing `loop-frame` phase back to `'act'` at `preservedActLeafMessageId`, and persists the `ContinuationFrame[]` stack with `pausedAtPhase: 'BEFORE_STOP_GATE'` (Case C).
        3. **Sibling Already Completed & Committed in the Same Batch:** Any sibling fork in the batch that already completed `commitChild` before the turn-batch barrier settled has its receipt recorded in `alreadyCommittedSiblingForks` on the interrupt return payload so the parent knows those edits already landed in `parentHandle`.
* **Normal Wire `tool_result` Completion to the Single Parent Timeline:**
    * The raising child's `.fork()` tool call in the parent's open batch resolves normally with:
~~~json
{
  "status": "SUSPENDED_ON_INTERRUPT",
  "suspendedForkId": "fork_api_01#1",
  "interruptId": "contract-violation",
  "payload": { "partition": "db", "brokenInvariant": "...", "proof": "...", "proposedPatch": "..." },
  "pausedSiblingForkIds": ["fork_db_01#1"],
  "alreadyCommittedSiblingForks": []
}
~~~
* Each paused sibling's `.fork()` tool call in the parent's open batch resolves normally with:
~~~json
{
  "status": "PAUSED_BY_SIBLING_INTERRUPT",
  "suspendedForkId": "fork_db_01#1",
  "triggeredByForkId": "fork_api_01#1",
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
* **Crash-Safe `syncChild` Rebase, Wire-Safe Resumption & Enclosing Loop Completion:**
    * Active `resumeFork` executions are tracked inside a `'fork-batch-frame'` on the parent's `ContinuationFrame[]` stack. For each `suspendedForkId` with `action: 'resume'`, if `syncedToParentCheckpoint` is not yet set on the fork entry, the runtime acquires the exclusive write lock on `parentHandle`, runs `const syncRes = await scope.syncChild(parentHandle, childHandle)` to dirty-safely stash, rebase onto the updated `parentHandle` HEAD, and reapply the child's uncommitted edits, persists `syncedToParentCheckpoint` (so a process crash mid-resumption never re-runs `syncChild` on reboot), releases the lock, and re-acquires any quiesced `ServiceSession` daemons for `activeSkillIds` (appending `[SERVICE_REACQUIRED]` notes if applicable).
    * **Case A (`suspensionReason === 'INTERRUPT_RAISED'`):** Appends `{ resolution: resolutionSummary, updatedTopologyContracts, sync: syncRes.data, conflict: syncRes.status === 'conflict' ? syncRes.conflictedSummary : undefined }` as the `tool_result` of the child's suspended interrupt tool call (`suspendedAtCallId`).
    * **Case B (`suspensionReason === 'PAUSED_BY_SIBLING_INTERRUPT'` at `TOOL_BOUNDARY`):** Invokes `ModelDriver.appendToolResultNotes(trailingFrame, [`[TOPOLOGY_SYNC]: ${resolutionSummary}\nUpdated Contracts: ${JSON.stringify(updatedTopologyContracts)}\nSync: ${JSON.stringify(syncRes.data)}`])` and persists the updated frame via `LedgerStore.replaceMessageFrame(runId, updatedFrame)`.
    * **Case C (`suspensionReason === 'PAUSED_BY_SIBLING_INTERRUPT'` at `BEFORE_STOP_GATE`):** Appends a synthetic `user` frame (`[TOPOLOGY_SYNC_REVERIFY]: Upstream contract updated (${resolutionSummary}). Updated Contracts: ${JSON.stringify(updatedTopologyContracts)}. Sync: ${JSON.stringify(syncRes.data)}. Verify your implementation against the synced workspace before completing.`) after the child's prior `assistant` completion turn with `neutralSyncContinuation: true`—preserving strict `assistant -> user -> assistant` alternation and forcing the worker to re-verify before `beforeStop` **without** incrementing `beforeStop` failure counts, **without** triggering `.onGateRecovery()`, and preserving `'clean_pass'` lesson attribution if post-sync verification passes on the first try.
    * **Full Continuation-Stack Execution & Recursive Interrupt Safety:** As the resumed inner `agent-frame` completes and passes `beforeStop`, execution pops up the restored `ContinuationFrame[]` stack—inheriting `loop-frame.grantedLoopLeases` and running any enclosing `loop-frame` (`evaluator` in `verifiedWorkerLoop`) before invoking `commitChild` and calling `LedgerStore.resolveSuspendedFork(suspendedForkId, 'RESUMED')`. The `resumeFork` tool returns a per-fork array of discriminated results (`COMPLETED | SUSPENDED_ON_INTERRUPT | PAUSED_BY_SIBLING_INTERRUPT`), so if a resumed fork raises a second `contractViolation`, it increments `suspensionEpoch` (`${forkId}#2`), cleanly re-suspends, and returns a new `SUSPENDED_ON_INTERRUPT` entry to the parent.

## 3.8 Iterative Refinement Loops (`H.loop`), Telemetry Aggregation & Loop-Scoped Lease Inheritance

`H.loop(id)` implements `StepExecutable<TIn, TOut, THandle>` by coupling an action step with an evaluation step:

* `.input(inSchema).output(outSchema).partitions(mapper).maxIterations(N).preserveActorSession(boolean).distillLessonsInto(lessons)`
* `.act(stepId, actor, $act => ...)`: Executes `actor`. When `preserveActorSession` is `true`, subsequent iterations resume the actor's existing conversation session with `feedbackMapper(evalResult)`.
* `.evaluate(stepId, evaluatorActor, { mapInput: (loopInput, actOutput, scopeReceipt) => evalInput, acceptWhen: (evalOut) => boolean, feedbackMapper: (evalOut) => string })`: Before invoking `evaluatorActor`, the harness calls `IsolationScope.inspect(scopeHandle)` and passes the resulting `scopeReceipt` into `mapInput`.
* **Cumulative Loop Telemetry Aggregation:** `H.loop` aggregates all `ToolEffect` records (`custom` metrics via `TelemetryCollector.collect`), `turnsTaken`, `costUsd`, `durationMs`, and `abortMeta` across all inner `.act()` and `.evaluate()` iterations into the loop step's `UniversalStepTelemetry`, ensuring enclosing `.onInterrupt()` / `.replaceWith()` handlers receive complete file-access traces and abort metadata.
* **Loop-Scoped Lease, Effect & Scoped-Rule Inheritance (`grantedLoopLeases`, `observedEffects`, `injectedScopedRuleIds`):** Any `LeaseDelta` granted to the `.act()` actor during Iteration $k$ (for example, `leaseAdjudicator` unlocking an existing test file), along with `observedEffects` and `injectedScopedRuleIds`, is recorded on the enclosing `loop-frame` and automatically inherited by Iteration $k+1..N$—even when Iteration $k+1$ escalates to a new model via `prepareFork()` or resumes after a sibling-interrupt rollback.
* **Derived Loop Clones (`.withTools(...ToolDefinition[])` & `.withPolicy(policy)`):**
    * Calling `loop.withTools(...extraTools)` returns a derived `H.loop` clone whose inner `.act()` actor appends `extraTools` to its toolset for that invocation.
    * Calling `loop.withPolicy(newPolicy)` returns a derived `H.loop` clone whose inner `.act()` actor applies `newPolicy` (preserving all actor-level `.onInterrupt()` handlers on the `.act()` actor while leaving the `.evaluate()` actor's `readOnlyPolicy` intact).
* **Model Escalation Across Preserved Sessions:** When `preserveActorSession(true)` is enabled on an actor backed by a model pool with `.escalateOnRetry()`, an evaluation rejection (`acceptWhen(evalOut) === false`) counts as a retry trigger. If Iteration $k$ executed on model $M_1$ and Iteration $k+1$ escalates to model $M_2$ ($M_1 \ne M_2$), the runtime passes the session history through `ModelDriver.prepareFork({ historyMode: 'clone-transcript', parentChain, forkPointMessageId: leafMessageId, wirePrefix, childRoleContextFrameText }, { modelId: M_2, substituteTombstones: true })` before invoking Iteration $k+1$.
* **Continuation-Stack Interrupt Bubbling:** Any `H.interrupt` raised inside `.act()` or `.evaluate()` not caught by an actor-level or step-level `.onInterrupt()` handler pushes the active `loop-frame` onto `continuationStack` and bubbles up transparently to the enclosing `.fork()`, `.speculate()`, or `H.flow` step.
* `.returnOutputFrom(actStepId)`: Projects the accepted action step's output as the loop's output.

## 3.9 Declarative Flows (`H.flow`), Crash Recovery, `scopeReceipt` Projection & Interrupt Edges

`H.flow(id).input(inSchema).scope(isolationScope).telemetry(telemetryCollector)` chains sequential `.step()` and conditional `.branch()` nodes.

* **Reboot Crash Recovery (`getInterruptedStepsOnBoot` + `reattachRoot`/`reattachChild`):** On startup, the runtime queries `LedgerStore.getInterruptedStepsOnBoot()`, calls `IsolationScope.reattachRoot(runId, baseScopeCheckpoint)` (and `BranchableScope.reattachChild` for any active `'fork-batch-frame'`, `'speculate-frame'`, or `SuspendedForkRecord` child handles), restores the serialized tree-structured `ContinuationFrame[]` stack into `ExecutionContext.resumeContinuationStack`, re-acquires any quiesced services for `activeSkillIds`, and resumes execution from the exact `H.loop` iteration, `speculate-frame` phase, `agent-frame` message chain, and `pendingToolBatch`.
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

## 3.10 Lanes (`H.lane`), Hierarchical Rewind Drain Barrier, Ledger Compaction & Root Harness (`H.harness`)

~~~ts
export const BudgetApprovalSchema = z.object({
  approved: z.boolean(),
  increaseLimitToUsd: z.number().optional(),
});
~~~

* **`H.lane(id)`:** Binds `.input(schema)`, `.key(mapper)`, `.tracker(adapter, $t => ...)`, `.flow(flow)`, `.concurrency(N)`, `.priority('low' | 'normal' | 'high' | 'critical')`, `.agingMinutes(M)`, `.waitFor(depsMapper, onAbandonedState)`, `.maxCostUsd(limit, human.withName(alias).output(H.BudgetApprovalSchema))`, `.retry($r => ...)`, and `.onSignal(sig, $s => $s.update(mapper).rewindTo(stepId, { onRewind?: ScopeRewindHook }))`.
* **Hierarchical Rewind Drain Barrier & Deferred Rewind While `'SUSPENDED'`:**
    * When `.onSignal(sig, $s => $s.update(mapper).rewindTo(stepId, { onRewind }))` triggers on an active (`'RUNNING'` or `'WAITING'`) run, the runtime executes a deterministic hierarchical drain before touching `rootHandle`:
        1. Fires the step's `AbortSignal` across all in-flight LLM turns, subprocesses, child `.fork()`s, `.speculate()` branches, and pending `HumanAdapter.requestDecision` calls (and calls `HumanAdapter.cancelDecision(runId, requestId)` if implemented).
        2. Waits for all in-flight child tasks to settle, stops all active `ServiceSession` daemons across the run and its children, and acquires the exclusive write lock on `rootHandle` via `ScopeLockManager`.
        3. Calls `scope.release(childHandle)` on all active and suspended child handles and resolves all open `SuspendedForkRecord`s for `runId` as `'ABORTED'` in `LedgerStore`.
        4. Invokes `await onRewind.onRewind(rootHandle, stepBaseScopeCheckpoint)` (if configured), updates the run's input via `mapper(curInput, sigPayload)` in `LedgerStore`, and restarts `stepId` with a clean `ContinuationFrame[]` stack.
    * If `.rewindTo(stepId)` triggers while the run is `'SUSPENDED'` waiting on spawned prerequisite tasks (`onPrerequisiteSpawned: 'suspend-and-yield-slot'`), the runtime immediately persists the updated input from `mapper(curInput, sigPayload)` and sets `rewindPendingToStepId = stepId` in `LedgerStore`, deferring `onRewind` and step restart until all spawned prerequisites exit, `syncRunOverlays` + `syncRoot` complete, and the run re-acquires a lane concurrency slot.
* **Ledger Compaction (`.compactWhen($c => ...)`):** Configured on `LedgerStore` builders (`sqlite.ledger(uri)`, `postgres.ledger(uri)`) via `.compactWhen($c => $c.onSignal(sig, { correlateBy, afterGracePeriodHours }).onTerminalExit(states, { afterGracePeriodHours }).retainFailedRunsForDays(days))` to prune raw `WireFrameRecord` payloads (`LedgerStore.compactRunFrames(itemKey)`) after the grace period while retaining run receipts and telemetry.
* **`H.harness(id)`:** Composes `.ledger(ledgerStore)`, `.pools(...pools)`, `.streams(...streams)`, `.lanes(...lanes)`, `.onSignal(sig, $s => $s.notify(human, mapper))`, and `.expose(...controlPlaneAdapters)`.

---

# 4. Peer Adapter Package Specifications

## 4.1 `@harness-dsl/claude` & `@harness-dsl/openai`

* **`@harness-dsl/claude`:** Implements `ModelDriver` for Anthropic API and Claude CLI seat pools (`claude.cliAccount(id).configDir(path)`, `claude.cliAccount(id).apiKey(envRef)`, `claude.model(id, { id }).accountPool(pool)`). Uses `CompiledWirePrefix` from `H.prefixGroup` so top-level `system` (and role-scoped or union `tools`) definitions remain byte-identical across invocations. Supports `toolChoice: 'auto' | 'none'` (preserving `wireToolSchemas` during epistemic flush turns) and `targetCallId` in `appendToolResultNotes` (updating both `rawWireFrame` and `frame.canonical`). Preserves exact Anthropic wire JSON (including `thinking` blocks and cryptographic `signature` fields) in `rawWireFrame`. On `prepareFork`:
    * If `ctx.historyMode === 'shared-prefix-only'`, starts a clean transcript after the cached `CompiledWirePrefix` seeded with `ctx.childRoleContextFrameText`.
    * If `ctx.historyMode === 'clone-transcript'` and `target.substituteTombstones === false` (all same-model forks, `sourceModelId === targetModelId`), replays `rawWireFrame` untouched up to `forkPointMessageId` with `cache_control: { type: 'ephemeral' }` and appends `ctx.childRoleContextFrameText`.
    * If `target.substituteTombstones === true` (cross-model retry escalation where `sourceModelId !== targetModelId` and provider KV cache and thinking signatures do not transfer), substitutes `compactedTombstone` strings on completed skill activation frames and projects `CanonicalMessage` frames.
* **`@harness-dsl/openai`:** Implements `ModelDriver` for OpenAI Responses API and Codex CLI seats (`openai.account(id)`, `openai.model(id, { id })`), supporting `shared-prefix-only` warm prefix forks, server-side `previous_response_id` branching on `clone-transcript` same-model forks (`substituteTombstones: false`), `toolChoice: 'auto' | 'none'`, `targetCallId` in `appendToolResultNotes`, and `compactedTombstone` substitution exclusively on cross-model escalations (`sourceModelId !== targetModelId`).

## 4.2 `@harness-dsl/node` (OS Subprocesses, Stream Checks, Daemons & MCP)

Owns all POSIX/OS process execution, standard stream contracts, and dynamic TCP port allocation:

* **`local.runner({ slots: number, maxDaemons?: number }): Runner`:** Separates one-shot command execution concurrency (`slots`, acquired by `local.command` and `local.streamCheck`) from long-lived background service concurrency (`maxDaemons`, defaulting to `slots`, acquired by `local.daemon` `ServiceSession`s) so active daemons never starve one-shot test or build commands. Manages process-group cleanup (`SIGTERM` followed by `SIGKILL` on orphaned trees) and ephemeral port locks.
* **`local.command(id)`:** Implements `StepExecutable` (and `.asTool(): ToolDefinition`, `.asCheck(): Check`). Enforces `.stdin('closed')` or `.stdin(bufferMapper)` so interactive CLI prompts never hang runner slots. Supports `.unrepeatable(preCheckCmd, { key })`. Calling `.asTool()` omits `describeEffects` so any workspace mutations performed by the subprocess are post-flight diffed and policy-checked by `CheckpointableScope.diffEffects()`.
* **`local.streamCheck(id)`:** Implements `Check` (and `.asTool(): ToolDefinition`, `StepExecutable`). Streams subprocess `stdout`/`stderr` and supports `.circuitBreakWhenStdout(regex, { graceLinesAfterMatch })` to abort slow verification suites on the first failure stack trace. Calling `.asTool()` exposes an in-session verification tool that **omits `describeEffects`**—ensuring that if code executed during a test run (such as a newly created test file) attempts to write to protected files (`packages/*/src/index.ts`, `PRODUCT_SPEC.md`, or existing `*.test.ts` files), `CheckpointableScope.diffEffects()` detects the unauthorized write post-flight, rolls back the working tree delta via `restoreCheckpoint`, and raises the policy's violation interrupt.
* **`local.daemon(id)`:** Implements `H.Service`. Declares static `toolSchemas` up front for all `.interact()` tools so wire-level tool definitions remain static across skill activation/deactivation. Manages a stateful background process bound to `.lifecycle('scope' | 'fork' | 'skill')` with dynamic conflict-free port allocation (`.port(name)`), `.start(({ ports, scopeKey, worktreePath }) => argv)`, `.stopCommand(({ ports, scopeKey, worktreePath }) => argv)`, `.readyWhenStdout(regex)`, and framed turn-based interaction tools (`.interact(toolName, { command, frameDelimiter, idleSettleMs, timeoutSeconds })`). On `ServiceSession.stop()`, executes `.stopCommand` (if configured), sends `SIGTERM` to the process group with a grace window before escalating to `SIGKILL`, and releases allocated ports only after the process exits.
* **`mcp.server({ port: number }): ControlPlaneAdapter`:** Exposes harness runtime status and signal triggers over Model Context Protocol.

## 4.3 `@harness-dsl/fs` (Filesystem Effects, Partition Maps, Guards & Tools)

Owns all POSIX file path matching, filesystem guards, and file telemetry:

* **`FsToolEffect`:** `{ kind: 'fs:effect', mutatesScope: mode === 'write', attributes: { mode: 'read' | 'write', paths: readonly string[] } }`.
* **`fs.text(filePath): Source<string>`:** Lazily loads UTF-8 file text with SHA-256 digest.
* **`fs.matchGlobs(globs: string[], mode?: 'read' | 'write' | 'any'): EffectMatcher`:** Matches `FsToolEffect` paths against glob patterns.
* **`fs.partitionMap(topology, Record<PartitionId, { globs: string[], boundaryGlobs: string[] }>)`:** Maps logical `H.topology` partitions to physical filesystem globs and public boundary files.
* **`fs.inPartition(partitionMap, partitionId): ScopePredicate`** & **`fs.boundaryGuard(partitionMap): PolicyGuard`:** Connects `partitionMap` to scoped rules/skills and blocks unapproved edits to `boundaryGlobs`.
* **`fs.writeGuard({ denyGlobs: string[], allowGlobs?: string[] }): PolicyGuard`** & **`fs.allowWriteGlobs(globs: string[]): LeaseDelta`**.
* **`fs.maxFilesMutated(count: number): QuotaTripwire`:** Trips when distinct mutated file paths exceed `count`.
* **`fs.telemetry(): TelemetryCollector<{ filesRead: string[], filesMutated: string[] }>`:** Collects accessed file paths from `FsToolEffect` records into `stepTelemetry.custom`.
* **`fs.regexCheck(id, { targetGlobs, forbidPattern, violationMessage }): Check`**.
* **`fs.jsonlLessonStore({ definitionsDir: string, statsPath: string, lockFile: string }): LessonStore`:** Strictly obeys Invariant 5 by resolving all paths against the harness host root, never touching active worktree directories during `admit()` or `recordOutcomes()`. Splits immutable, content-addressed lesson definition files (`<definitionsDir>/<lessonId>.json`, storing `id`, `partition`, `directive`, `epochAtCreation` so git-tracking never suffers adjacent-line EOF `.jsonl` rebase conflicts) from high-frequency, git-ignored telemetry counters (`statsPath`, storing `recentOutcomes`, `totalCleanPasses`, `totalViolated`). Synchronizes concurrent reads/writes via kernel-level advisory locking (`flock(2)`) on `lockFile` (which automatically releases on abrupt process death / `SIGKILL`) and commits `statsPath` updates via write-to-temp (`${statsPath}.tmp.${pid}`) + atomic POSIX `rename(2)`.
* **`fs.codingTools(runner)` & `fs.readOnlyTools(runner)`:** Workspace-jailed file and search tools emitting `FsToolEffect` descriptors with static `describeEffects` implementations (`mutatesScope: false` for read/search tools, `mutatesScope: true` for write/edit tools).

## 4.4 `@harness-dsl/git` (CoW Worktree Scope, Crash Reattachment, Deterministic Git-Index Checkpoints & Reconciliation)

Owns all git version control and worktree isolation mechanics:

* **`git.ScopeReceiptSchema`:**

~~~ts
z.object({
  headRef: z.string(),
  baseRef: z.string(), // Immutable base commit SHA against which working-tree diffs & squashes are computed
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
    * **Portable CoW Clone Fallback Chain, Monorepo-Safe `node_modules` Cloning, Path-Bound Cache Exclusion, `GIT_CEILING_DIRECTORIES` & Crash Reattachment (`reattachRoot` / `reattachChild`):**
        * Records an immutable `baseRef` commit SHA on `GitWorktreeHandle` upon `acquireRoot` / `forkChild` (updated **only** when `commitChild`, `syncChild`, or `syncRoot` advances the worktree's base lineage).
        * Probes the host filesystem on initialization and cascades automatically:
            1. `cp -c` (macOS APFS) or `cp --reflink=always` (Linux Btrfs / XFS) linked to the host repository's shared git object store.
            2. `git worktree add` + recursive monorepo-safe `**/node_modules` clone on standard Linux `ext4` filesystems (recursively cloning root `node_modules` and workspace `packages/*/node_modules` by preserving symbolic links via `cp -P` for workspace links while hardlinking regular package files via `cp -al`).
        * `.excludeFromCloneGlobs(['dist/**', '.next/**', 'coverage/**', '**/*.tsbuildinfo', '.harness-ephemeral/**', '**/node_modules/.cache/**', '**/node_modules/.vite/**', '**/node_modules/.vitest/**'])` omits path-embedded incremental build/test caches and ephemeral service data directories during worktree cloning.
        * Injects `GIT_CEILING_DIRECTORIES=<worktreePath>` and `GIT_CONFIG_NOSYSTEM=1` into all git and subprocess environments inside the worktree so nested directories can never accidentally traverse upward into a parent repository.
        * Implements `reattachRoot(runId, checkpoint?)` and `reattachChild(parentHandle, forkId, checkpoint?)` by rebinding the deterministic worktree directory `<dir>/<runId>` (or `<dir>/<runId>/forks/<forkId>`) on disk—or recreating it from the host-pinned checkpoint git tree object if the ephemeral directory was cleaned—and restoring `checkpoint` so interrupted runs recover seamlessly after a process restart.
    * **`headSha`-Verified Symmetric Git-Index Checkpoints (`serializeCheckpoint` / `restoreCheckpoint` / `diffEffects`):**
        * Configured via `.checkpointPolicy({ partitionMap, excludeGlobs: ['dist/**', '.next/**', 'coverage/**', '.harness-ephemeral/**', '**/node_modules/.cache/**', '**/node_modules/.vite/**', '**/node_modules/.vitest/**'], maxUntrackedFileSizeBytes: 1_048_576 })`.
        * `serializeCheckpoint(handle)` records `{ headSha, statusMap, treeSha }`, where `headSha` is `git rev-parse HEAD`, `statusMap` maps every tracked dirty file and untracked file from `git status --porcelain=v2 -z --untracked-files=all` (excluding `.gitignore` and `excludeGlobs`) to its SHA-256 content hash (or `(size, mtimeNs)` for untracked files exceeding `maxUntrackedFileSizeBytes`), and `treeSha` stages all tracked and qualifying untracked files ($\le \text{maxUntrackedFileSizeBytes}$) into a temporary `GIT_INDEX_FILE` (`git write-tree`) without writing oversized untracked artifacts into the git object store.
        * Post-flight `diffEffects(fromCheckpoint, handle)` first verifies `currentHeadSha === fromCheckpoint.headSha` (treating any unauthorized `HEAD` or `.git/refs` mutation by a subprocess tool as a guard violation) and then computes the **symmetric difference** between `fromCheckpoint.statusMap` and `currentStatusMap` across all repository paths (so both newly dirtied files and previously dirty files reverted back to `HEAD` by a subprocess are deterministically emitted as `FsToolEffect { mutatesScope: true, attributes: { mode: 'write', paths } }`).
        * `restoreCheckpoint(handle, fromCheckpoint)` resets `HEAD` to `fromCheckpoint.headSha` if needed, restores tracked and small untracked files from `fromCheckpoint.treeSha`, and unlinks any newly created untracked files (including oversized untracked files) present in `currentStatusMap` but absent from `fromCheckpoint.statusMap`.
    * **Side-Effect-Free Temporary-Index `inspect(handle)` & Zero-Pollution Conflict-Bouncing `commitChild` / `syncChild`:**
        * `inspect(handle)` is **100% non-mutating** on the worktree's live `.git/index` and `HEAD`: it stages all non-excluded working-tree mutations into a temporary `GIT_INDEX_FILE`, writes a deterministic commit object over `handle.baseRef` into the host object store (`git write-tree` + `git commit-tree -p <handle.baseRef>`), pins `refs/harness/candidates/<run-id>/<branch-index>` when inspecting a speculative branch, and computes `diffStat` and `mutatedFiles` against `handle.baseRef` while leaving the worktree's `HEAD` and working tree untouched across multi-iteration `H.loop` evaluations.
        * `commitChild(child, parent)` synthesizes the commit on `child` over `child.baseRef` at commit time and checks if it is a clean fast-forward over `parent`. If `parent` has advanced, `commitChild` rebases `child` onto `parent` *inside `child`* and updates `child.baseRef`. If a merge conflict occurs, `parent` remains completely untouched and `commitChild` returns `{ status: 'conflict', conflictedSummary, data }` so Core bounces the conflict back into the child agent session for repair.
        * `syncChild(parent, pausedChild)` snapshots scoped uncommitted edits in `pausedChild`, rebases `pausedChild` (and advances `pausedChild.baseRef`) onto `parent`'s updated `HEAD`, and re-applies the uncommitted edits via 3-way file merge (`git merge-file`). If conflict markers (`<<<<<<<`) are produced, `syncChild` returns `{ status: 'conflict', conflictedSummary, data }` and arms `conflictCleanCheck` (which rejects `beforeStop` until `git diff --check` reports zero conflict markers).
    * **Stacked-PR Prerequisite Lineage (`syncRoot`):**
        * Before `release()` deletes an ephemeral CoW worktree directory from disk, it pins the worktree's terminal commit to `refs/harness/completed/<run-id>` in the host repository's git object store and prunes ephemeral checkpoint objects.
        * When `syncRoot(rootHandle, prereqReceipts)` rebases a resumed parent Task Root Worktree onto a completed prerequisite's `headRef` (advancing `rootHandle.baseRef`), it checks whether the prerequisite's `branchName` (e.g., `fix/#102`) has been merged into `origin/main`. If not yet merged, `syncRoot` sets `rootHandle.baseBranch = prereqReceipt.branchName` (`fix/#102`).
    * **Reconciliation Strategies (`.reconcileStrategy('rebase-onto-base' | 'batch-merge-train', opts)`):**
        * `'rebase-onto-base'` (for PR-opening lanes): Rebases each completed Task Root Worktree onto the latest commit of its own `scopeReceipt.baseBranch` (`origin/main` or its stacked prerequisite branch) and runs `verifyWith` so each feature branch PR contains only its own commits.
        * `'batch-merge-train'` (for direct branch-landing / auto-merge queues): Speculatively constructs a cumulative rebase chain ($R_1, R_1 + R_2, \dots, R_1 + \dots + R_k$, up to `maxBatchSize`) across completed runs landing into the target branch, runs `verifyWith` once on the cumulative head $R_k$ (fast-tracking partition-disjoint changes), and bisects only if $R_k$ fails verification.
* **`git.snapshotAndReset(): AbortHook<GitWorktreeHandle, GitAbortMeta>`:** Synthesizes a snapshot commit of the current working tree over `handle.baseRef` to `refs/harness/aborted/<run-id>` in the host repository and resets the worktree to clean `handle.baseRef` (`git reset --hard <handle.baseRef>` + `git clean -fd`).
* **`git.keepWorktree()` & `git.resetWorktree()`:** `ScopeRewindHook` implementations for `.rewindTo()`.
* **`git.publicSurfaceCrossTester({ runner, partitionMap }): CrossVerifier`:** Parses AST imports of newly added test files across speculative worktrees and cross-executes tests that import exclusively from `boundaryGlobs`.
* **`git.refReaderTools(runner)` & `git.candidateComparisonTools(runner)` & `git.commitAndPush(id, opts)`:**
    * `git.refReaderTools(runner)` exposes read-only git object inspection tools (`readRefFile`, `diffRefs`, `listRefFiles`) implemented via pure `git show` / `git diff-tree` against the object store (`describeEffects: () => []`) so `coordinator` can inspect `refs/harness/aborted/<run-id>` snapshots after a fast-path `scopeTripwire` or `contractViolation` reset.
    * `git.candidateComparisonTools(runner)` exposes candidate inspection and benchmark tools (`diffCandidates`, `readCandidateFile`, `evalInCandidates`) capable of reading `refs/harness/candidates/<run-id>/<branch-index>` (and running benchmarks in live candidate worktrees during `candidateArbiter` evaluation and `refineWinnerWhen` cross-pollination prior to post-refinement `release()`).
    * `git.commitAndPush(id, { branch, message }).input(schema).runner(runner).env(envRecord)` implements `StepExecutable<TIn, void, GitWorktreeHandle>`: squashes and commits all changes in `rootHandle` since `rootHandle.baseRef` using `message(input)`, verifies whether `scopeReceipt.baseBranch` has already merged into `origin/main` (falling back to `baseBranch = 'main'` if the prerequisite PR branch was merged and deleted on the remote), executes the workspace's configured `.reconcileStrategy('rebase-onto-base', { verifyWith })` against `origin/${scopeReceipt.baseBranch}`, and pushes `HEAD` to `branch(input)`.

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

// Policy guards operate pre-flight over static describeEffects() on Stripe/NetSuite API tools.
// Refunds > $500 are intercepted pre-flight in PendingToolBatch (keeping the draft journal intact
// while awaiting financeController) and replayed automatically when allowRefundUpToUsd(10_000) is granted.
const autoReconcilePolicy = H.policy('auto-reconcile-bounds')
  .guard(
    netsuite.forbidClosedPeriodPosting(),
    stripe.maxRefundGuardUsd(500),
  )
  .onViolation('raise-interrupt', highValueApprovalRequest, (violation) => ({
    proposedJournalId: String(violation.violatedEffects[0]?.attributes?.journalId ?? 'draft'),
    amountUsd: Number(violation.violatedEffects[0]?.attributes?.amountUsd ?? 0),
    reason: violation.violationSummary,
  }))
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