# @paraharness Framework & Ecosystem Specification (V7)

# 1. Scope, Design Principles & Package Topology

`@paraharness` is a declarative, durable execution framework for orchestrating autonomous LLM actors, deterministic tools, lifecycle-bound services, and human escalations over isolated execution scopes.

The architecture enforces a strict boundary between **Execution Topology** (`@paraharness/core`) and **Environment/Vendor Adapters** (peer packages). `@paraharness/core` contains zero concepts specific to software engineering, source-code testing, POSIX filesystems (read/write/execute modes, file globs), OS subprocesses (`argv`, `stdin`, `stdout`, TCP ports), version control (git, commits, diffs, rebasing), relational databases, or LLM provider wire formats.

## 1.1 Package Boundaries

| Package | Responsibility |
| :--- | :--- |
| **`@paraharness/core`** | Pure passive discriminated-union AST compilation (`CoreASTNode` and `DomainASTNode` with string-literal `readonly type: '...'` discriminants, fluent `AstBuilder<TNode>.toAST()`, and static build-time `capabilityTier` / `effectTracking` / `interactionMode` validation with zero execution or builder methods on AST nodes), universal `NodeExecutor<TNode, TInput, TOutput, TContext>` and `NodeExecutorMap` contracts, `switch (node.type)` compile-time step dispatch (`executeStepNode` -> `executeAgent`, `executeLoop`, `executeCommand`, and domain step executors), `RuntimeExecutorRegistry`, swappable `HarnessExecutionEngine` (`@paraharness/core/runtime`), Run-Immutable Unified Warm-Fork Prefix compilation (`P.prefixGroup` with `'role-scoped'` and `'union'` tool modes, AST declaration-order pinning, JSON-serializable `wireToolSchemasByRoleKey` and `groundingSnapshots`), run-sticky account seat affinity, durable state machine transitions, reboot-safe tree-structured continuation call-stack (`ContinuationFrame[]` including `'fork-batch-frame'` and `'speculate-frame'`) persistence serialized through a per-step async queue, capability-tiered isolation scope runtime contracts (`IsolationScope`, `CheckpointableScope`, `BranchableScope`) with crash-recovery handle reattachment (`reattachRoot`, `reattachChild`), per-handle shared-read / exclusive-write scope locks (`ScopeLockManager`) keyed on `ToolEffect.mutatesScope`, downward fork/join lifecycle (`historyMode: 'shared-prefix-only' \| 'clone-transcript'`) with idempotent conflict-bounce reconciliation and automatic step-boundary service quiescing, speculative execution tournaments with deferred escalation parking (`PARKED_ON_ESCALATION`) and non-destructive contested arbitration (`select-winner` vs `unpark-escalation` vs `reject-all`), upward interrupt suspension (`suspendAndReturnToParent`) with turn-batch sibling pause barriers, evaluator-to-actor rollback, and native `resumeFork` resolution on a single parent timeline, chained `.guard(...).onViolation(...)` policy clauses with loop-scoped capability lease inheritance and declaration-ordered `PendingToolBatch` (`remainingCalls`) replay, quota tripwires with KV-cache-preserving `toolChoice: 'none'` epistemic flush turns, run-isolated Copy-on-Write relational topology epoch tracking (`affectedBy`, `dependentsOf`) with monotonic 3-way signal-correlated overlay commits, explicit `.partitions()` extraction, linear-chained prerequisite spawning & priority-boosted scheduling, deduplicated 4-state evidence-based lesson scoring math, hierarchical rewind drain barriers, and ledger lifecycle orchestration. |
| **`@paraharness/claude`** | Passive AST nodes (`ClaudeAccountSeatNode` (`type: 'claude:account-seat'`), `ClaudeModelNode` (`type: 'claude:model'`)) and runtime `ModelDriver` implementation for Anthropic `/v1/messages` HTTP protocol across Claude CLI subscription seats (extracting OAuth credentials from `~/.claude-*` `configDir`) and API key fallback seats (run-sticky seat affinity, native JSON-schema structured output via `output_config.format`, cryptographic `thinking` signature preservation, role-scoped vs union prefix wire assembly, `shared-prefix-only` vs `clone-transcript` fork preparation with full-turn `(1..k)` stub `tool_result` pairing across both `substituteTombstones` branches, per-`callId` cross-model-only `compactedTombstones` substitution, wire-safe `appendToolResultNotes` with `opts?: { isError?: boolean }` across `tool` and `user` frames, `toolChoice: 'auto' \| 'none'`, and ephemeral KV-cache breakpoint injection). |
| **`@paraharness/openai`** | Passive AST nodes (`OpenAiAccountSeatNode` (`type: 'openai:account-seat'`), `OpenAiModelNode` (`type: 'openai:model'`)) and runtime `ModelDriver` implementation for OpenAI Responses API (`previous_response_id` server-side branching with run-sticky seat affinity and automatic cross-seat failover stripping of account-bound `previous_response_id`, item IDs `rs_...`/`fc_...`/`msg_...`, and `encrypted_content`, native JSON-schema structured output via `text.format`, role-scoped vs union prefix wire assembly, `shared-prefix-only` vs `clone-transcript` fork preparation with full-turn `(1..k)` stub `function_call_output` pairing across both `substituteTombstones` branches, wire-safe `appendToolResultNotes` with `opts?: { isError?: boolean }` across `tool` and `user` frames, `toolChoice: 'auto' \| 'none'`, and per-`callId` cross-model-only `compactedTombstones` substitution) and Codex CLI seats. |
| **`@paraharness/gemini`** | Passive AST nodes (`GeminiAccountSeatNode` (`type: 'gemini:account-seat'`), `GeminiModelNode` (`type: 'gemini:model'`)) and runtime `ModelDriver` implementation for Google Gemini `generateContent` HTTP protocol (`/v1beta/models/{model}:generateContent`) across Gemini API key seats and CLI/ADC seats (`gemini.account`, `gemini.cliAccount`, `gemini.model` with run-sticky seat affinity, native JSON-schema structured output via `generationConfig.responseMimeType: 'application/json'` and `generationConfig.responseJsonSchema`, `thinkingConfig` (`thinkingLevel` / `includeThoughts: true`) with cryptographic `thoughtSignature` preservation on model `thought` and `functionCall` parts, role-scoped vs union prefix wire assembly via `systemInstruction` and `tools: [{ functionDeclarations }]`, `shared-prefix-only` vs `clone-transcript` fork preparation with full-turn `(1..k)` `functionResponse` pairing across both `substituteTombstones` branches, per-`callId` cross-model-only `compactedTombstones` substitution, wire-safe `appendToolResultNotes` with `opts?: { isError?: boolean }` across `tool` (`functionResponse`) and `user` frames, and `toolConfig.functionCallingConfig.mode: 'AUTO' \| 'NONE'` for `toolChoice: 'auto' \| 'none'`). |
| **`@paraharness/node`** | Passive AST nodes (`NodeRunnerNode` (`type: 'node:runner'`), `LocalCommandNode` (`type: 'node:command'`), `LocalCommandToolNode` (`type: 'node:command-tool'`), `LocalCommandCheckNode` (`type: 'node:command-check'`), `LocalStreamCheckNode` (`type: 'node:stream-check'`), `LocalStreamCheckToolNode` (`type: 'node:stream-check-tool'`), `LocalServiceNode` (`type: 'node:service'`), `LocalServiceToolNode` (`type: 'node:service-tool'`), `NodeMcpStdioNode` (`type: 'node:mcp-stdio'`), `NodeMcpSseNode` (`type: 'node:mcp-sse'`), `NodeAllowBinariesNode` (`type: 'node:allow-binaries'`), `NodeDenyNetworkNode` (`type: 'node:deny-network'`), `NodeHttpControlPlaneNode` (`type: 'node:http-control-plane'`)) and runtime executors/drivers for local OS process slots and daemons (`local.runner({ id?, slots, maxDaemons })` backed by `RunnerDriver`), one-shot subprocess commands (`local.command` with `.unrepeatable()`), streaming subprocess checks with combined `stdout`/`stderr` rolling-window regex circuit-breakers (`local.streamCheck`), framed PTY background services (`.interact()` over a pseudo-terminal with `ECHO` disabled) with collision-free hash-suffixed `scopeKey` sanitization, pre-start cleanup, declared-port TCP readiness verification, and graceful process-group/subreaper shutdown (`local.daemon` with `.stopCommand()`), and Model Context Protocol control-plane servers (`mcp.server`). Subprocess `.asTool()` builders and service interaction tools emit `ToolASTNode` descriptors with `effectTracking: 'subprocess-post-flight'` (omitting static `describeEffects`) so workspace mutations are always verified post-flight (including on timeout/exception) via `CheckpointableScope.diffEffects()`. |
| **`@paraharness/fs`** | Passive AST nodes (`FsReadToolNode` (`type: 'fs:read'`), `FsEditToolNode` (`type: 'fs:edit'`), `FsWriteToolNode` (`type: 'fs:write'`), `FsGlobToolNode` (`type: 'fs:glob'`), `FsGrepToolNode` (`type: 'fs:grep'`), `FsTextSourceNode` (`type: 'fs:text-source'`), `FsGlobSourceNode` (`type: 'fs:glob-source'`), `FsProtectGuardNode` (`type: 'fs:protect'`), `FsReadOnlyGuardNode` (`type: 'fs:read-only'`), `FsAllowOnlyGuardNode` (`type: 'fs:allow-only'`), `FsRequireReadBeforeWriteGuardNode` (`type: 'fs:require-read-before-write'`), `FsScopedWriteGuardNode` (`type: 'fs:scoped-write'`), `FsSecretLiteralsGuardNode` (`type: 'fs:secret-literals'`), `FsWriteGuardNode` (`type: 'fs:write-guard'`), `FsBoundaryGuardNode` (`type: 'fs:boundary-guard'`), `FsQuotaTripwireNode` (`type: 'fs:quota-tripwire'`), `FsTelemetryCollectorNode` (`type: 'fs:telemetry'`), `FsRegexCheckNode` (`type: 'fs:regex-check'`), `FsJsonlLessonStoreNode` (`type: 'fs:jsonl-lesson-store'`), `FsPartitionMapNode` (`type: 'fs:partition-map'`), `FsGlobMatcherNode` (`type: 'fs:match-globs'`)) and runtime executors/drivers for filesystem `EffectMatcher` globs, write-policy guards (`fs.writeGuard` with `onlyExistingAtBaseRef?: boolean` and single-guard violating-path projection), file-count quota tripwires (`fs.maxFilesMutated`), mutated-file-scoped regex/AST deterministic checks, worktree-aware file source loaders, topology-to-glob partition maps (`fs.partitionMap`), host-root content-addressed lesson stores (`fs.jsonlLessonStore` with in-process async mutex queue + non-blocking kernel `flock(2)`, `fsync`, and atomic rename), file telemetry collectors, and workspace-jailed file tool bundles. |
| **`@paraharness/git`** | Passive AST nodes (`GitCowWorktreeNode` (`type: 'git:cow-worktree'`, `capabilityTier: 'branchable'`), `GitCommitAndPushNode` (`type: 'git:commit-and-push'`), `GitMergeQueueNode` (`type: 'git:merge-queue'`), `GitSnapshotAndResetNode` (`type: 'git:snapshot-and-reset'`), `GitKeepWorktreeNode` (`type: 'git:keep-worktree'`), `GitDiscardBranchNode` (`type: 'git:discard-branch'`), `GitCleanWorkingTreeNode` (`type: 'git:clean-working-tree'`), `GitPatchEquivalenceNode` (`type: 'git:patch-equivalence'`), `GitPublicSurfaceCrossTesterNode` (`type: 'git:public-surface-cross-tester'`), `GitRefReaderToolNode` (`type: 'git:ref-reader-tool'`), `GitCandidateComparisonToolNode` (`type: 'git:candidate-comparison-tool'`)) and runtime drivers for Copy-on-Write (CoW) hierarchical git worktree scopes (`git.cowWorktree`) implementing `BranchableScope` and `CheckpointableScope` over disjoint sibling directories (`<dir>/roots/<runId>` and `<dir>/forks/<runId>/<forkId>`) registered via `git worktree add --detach` + CoW/hardlink file tree cloning, persistent `<gitdir>/harness-meta.json` lineage and conflict tracking (`baseRef`, `baseBranch`, `branchName`, `unresolvedConflictPaths`, `pendingParentHeadSha`, `inFlightMerge`, `inFlightCommitAndPush`), internal per-`parentHandle` async flush mutex on `forkChild`, non-destructive crash-recovery reattachment (`reattachRoot`/`reattachChild`), path-cache exclusion (`excludeFromCloneGlobs`), `GIT_CEILING_DIRECTORIES=<dirname(worktreePath)>` and `GIT_OPTIONAL_LOCKS=0` subprocess isolation, hardened `--no-renames`/`lstat`/`--force-remove` git-index checkpointing (`serializeCheckpoint` / `restoreCheckpoint` / `diffEffects`) with worktree-local `.git` integrity verification, side-effect-free temporary-index commit synthesis (`inspect`) and candidate/completed ref pinning, stateless 3-way `git merge-tree --write-tree` conflict-bouncing `commitChild`/`syncChild`/`syncRoot`, paired-marker + `unresolvedConflictPaths` `conflictCleanCheck`, idempotent snapshot-and-reset abort hooks (`git.snapshotAndReset` keyed by `<run-id>/<stepExecId>`), lockfile-hash setup gates, `--onto` PR-branch reconciliation (`rebase-onto-base`) and cumulative landing merge trains (`batch-merge-train`), AST-gated public-boundary cross-verifiers, ref reader tools (`git.refReaderTools`), candidate comparison tools (`git.candidateComparisonTools`), and atomic retry-safe commit/push step executors (`git.commitAndPush` with `--force-with-lease`). |
| **`@paraharness/markdown`** | Passive AST nodes (`MarkdownFrontmatterSourceNode` (`type: 'markdown:frontmatter'`), `MarkdownSectionSourceNode` (`type: 'markdown:section'`)) and runtime frontmatter-aware source loaders emitting validated `GlobalRule`, `ScopedRule`, and `SkillNode` objects from Markdown files and directories (`@paraharness/markdown` translates frontmatter globs into `@paraharness/fs` `FsGlobMatcherNode` descriptors). |
| **`@paraharness/sqlite`** | Passive AST nodes (`SqliteLedgerNode` (`type: 'sqlite:ledger'`), `SqliteTopologyNode` (`type: 'sqlite:topology'`), `SqliteLessonsNode` (`type: 'sqlite:lessons'`), `SqliteRulesSourceNode` (`type: 'sqlite:global-rules'`)) and runtime WAL-mode SQLite drivers for `LedgerStore`, `TopologyStore`, `LessonStore`, and relational `SourceExecutor`s. |
| **`@paraharness/postgres`** | Passive AST nodes (`PostgresLedgerNode` (`type: 'postgres:ledger'`), `PostgresTopologyNode` (`type: 'postgres:topology'`), `PostgresLessonsNode` (`type: 'postgres:lessons'`), `PostgresRulesSourceNode` (`type: 'postgres:global-rules'`)) and runtime distributed PostgreSQL drivers for `LedgerStore`, `TopologyStore`, `LessonStore`, and relational `SourceExecutor`s. |
| **`@paraharness/github`** | Passive AST nodes (`GithubIssuesTrackerNode` (`type: 'github:issues'`), `GithubWebhookStreamNode` (`type: 'github:webhook-stream'`), `GithubCreateOrUpdatePrNode` (`type: 'github:create-or-update-pr'`)) and runtime issue tracker (`TrackerAdapter`), webhook event stream (`StreamSource`), and PR step executors. |
| **`@paraharness/slack`** | Passive AST nodes (`SlackApproverNode` (`type: 'slack:approver'`), `SlackNotifierNode` (`type: 'slack:notifier'`)) and runtime notification and interactive Socket Mode escalation/signal drivers (`HumanAdapter`, `ControlPlaneAdapter`). |

## 1.2 Declarative Compilation & Serialization Invariants

1. **Pure Passive Discriminated-Union AST & Builder Separation:** Every construct in `@paraharness/core` (`P.*`) and every domain package (`@paraharness/git`, `@paraharness/node`, `@paraharness/fs`, `@paraharness/markdown`, `@paraharness/sqlite`, `@paraharness/postgres`, `@paraharness/claude`, `@paraharness/openai`, `@paraharness/gemini`, `@paraharness/github`, `@paraharness/slack`) compiles at initialization time into a static, inspectable, passive Abstract Syntax Tree (AST) node discriminated by a unique string-literal `readonly type: '...'` property (`CoreASTNode | DomainASTNode`). Fluent DSL builders implement `AstBuilder<TNode>` (exposing `.toAST(): TNode`, while all composition methods accept `TNode | AstBuilder<TNode>` via `extractAST`), keeping builder methods off the passive AST nodes. AST nodes contain **zero execution methods** (no `.execute()`, `.run()`, `.evaluate()`, `.acquireRoot()`, `.provisionRoot()`, `.forkChild()`, `.forkBranch()`, `.commitChild()`, `.mergeBranch()`, `.serializeCheckpoint()`, `.createCheckpoint()`, `.poll()`, `.ask()`, `.start()`, `.load()`, or `.recordRunBoot()`). Static build-time validation in `P.flow`, `P.topology`, `P.agent`, and `P.loop` inspects declarative AST metadata (`capabilityTier: 'scope' | 'checkpointable' | 'branchable'` on `IsolationScopeASTNode` + compile-time type brand `TTier`, `effectTracking: 'declared' | 'subprocess-post-flight'` on `ToolASTNode`, and `interactionMode: 'bidirectional' | 'notify-only'` on `HumanChannelASTNode`)—never duck-typing runtime methods on AST objects.
2. **Forbidden Imperative Closures in Control Flow:** Arbitrary async JavaScript closures are prohibited inside control-flow builders (`.branch()`, `.onInterrupt()`, `.onChildInterrupt()`, `.onSignal()`). Inline TypeScript callbacks in control-flow builders MUST be pure, synchronous projection mappers (`(state, event, telemetry, scopeReceipt) => nextState`) transforming validated Zod schemas. `CommandNode` (`P.command(id, { input, output, fn })`) holds `readonly fn: (input: TIn, ctx: ExecutionContext<THandle>) => Promise<TOut>` as passive configuration data on the AST node and never executes itself (`command.execute` does not exist; the runtime's `executeCommand` `NodeExecutor` invokes `node.fn(input, ctx)`).
3. **Opaque Environment References (`P.env`):** Secrets and environment variables are referenced via `P.env(key: string): EnvRef` (`{ readonly type: 'harness:env-ref', readonly key }`). The AST compiler serializes only the symbolic `EnvRef` key; the secret value is resolved in-memory by the runtime leaf driver at invocation time and is never written to the ledger.
4. **Registry-Driven Runtime Execution & Swappable `HarnessExecutionEngine`:** Asynchronous I/O and effect evaluation occur strictly inside runtime executors and drivers (`NodeExecutor<TNode, TInput, TOutput, TContext>`, `IsolationScope`, `CheckpointableScope`, `BranchableScope`, `ModelDriver`, `RunnerDriver`, `ToolDriver`, and storage/external port drivers) mapped by `node.type` in `RuntimeExecutorRegistry`. Any `HarnessExecutionEngine` (`createRuntime(harness, options)`) can consume the passive `HarnessNode` AST, with `@paraharness/core/runtime` serving as the default execution engine.
5. **Host-Root Storage Port Resolution:** Harness-level storage drivers (`LedgerStore`, `TopologyStore`, `LessonStore`) always resolve file paths against the harness host process root, never against an active `IsolationScope` worktree directory.
6. **Run-Immutable Wire Prefix Invariant:** Sources bound to `P.prefixGroup().sharedGrounding()` are compiled in AST declaration order and snapshotted once in `LedgerStore` when a flow run starts. Dynamic state that can mutate mid-run (such as `P.topology` partition contract epochs, recalled lessons, or in-run edits made by an actor to grounding files like `TECH_DESIGN.md` or `PRODUCT_SPEC.md`) is never re-interpolated into the wire `system` prompt; instead, in-run grounding diffs and topology updates are injected exclusively into the Turn-0 `[ROLE_AND_SCOPE_CONTEXT]` user frame and `[TOPOLOGY_SYNC]` delta frames so byte 0 of the provider KV cache never invalidates mid-run.

---

# 2. `@paraharness/core` Pure AST Nodes, `NodeExecutor` Dispatch & Runtime Port Contracts

`@paraharness/core` and peer packages strictly separate **Pure Passive AST Nodes** (`CoreASTNode | DomainASTNode`, discriminated by `readonly type: '...'`) from **Runtime Execution Drivers & Storage Ports** (registered in `RuntimeExecutorRegistry` and executed by a `HarnessExecutionEngine`).

~~~ts
import { z } from 'zod';

// ============================================================================
// 2.1 Pure Passive AST Foundation, Fluent AstBuilder & CoreASTNode Union
// ============================================================================

export interface ASTNode {
  readonly type: string;
}

export interface AstBuilder<TNode extends ASTNode> {
  toAST(): TNode;
}

export type MaybeBuilder<TNode extends ASTNode> = TNode | AstBuilder<TNode>;

export function extractAST<TNode extends ASTNode>(input: MaybeBuilder<TNode>): TNode {
  return typeof (input as AstBuilder<TNode>).toAST === 'function'
    ? (input as AstBuilder<TNode>).toAST()
    : (input as TNode);
}

export type SourceValue<T> = T | SourceASTNode<T>;

export type MaybeSource<T> = SourceValue<T> | AstBuilder<SourceASTNode<T>>;

export interface EnvRef {
  readonly type: 'harness:env-ref';
  readonly key: string;
}

export interface SignalNode<TPayload = unknown> {
  readonly type: 'harness:signal';
  readonly id: string;
  readonly schema: z.ZodType<TPayload>;
}

export interface SignalBuilder<TPayload = unknown> extends AstBuilder<SignalNode<TPayload>> {
  readonly id: string;
  readonly schema: z.ZodType<TPayload>;
}

export interface InterruptNode<TPayload = unknown> {
  readonly type: 'harness:interrupt';
  readonly id: string;
  readonly schema: z.ZodType<TPayload>;
}

export interface InterruptBuilder<TPayload = unknown> extends AstBuilder<InterruptNode<TPayload>> {
  readonly id: string;
  readonly schema: z.ZodType<TPayload>;
}

export interface CrossVerifierBuilder<
  THandle = unknown,
  TReceipt extends Record<string, unknown> = Record<string, unknown>,
  TCrossReport = unknown,
  TNode extends CrossVerifierASTNode<THandle, TReceipt, TCrossReport> = CrossVerifierASTNode<
    THandle,
    TReceipt,
    TCrossReport
  >,
> extends AstBuilder<TNode> {
  readonly id: string;
  readonly reportSchema: z.ZodType<TCrossReport>;
}

export interface TopologyBuilder<TPartition extends string = string>
  extends AstBuilder<TopologyNode<TPartition>> {
  readonly id: string;
  dependentsOf(partitionId: TPartition): readonly TPartition[];
  affectedBy(partitionId: TPartition): readonly TPartition[];
}

export declare function dependentsOf<TPartition extends string = string>(
  topology: MaybeBuilder<TopologyNode<TPartition>>,
  partitionId: TPartition,
): readonly TPartition[];

export declare function affectedBy<TPartition extends string = string>(
  topology: MaybeBuilder<TopologyNode<TPartition>>,
  partitionId: TPartition,
): readonly TPartition[];

export interface StreamNode<TEvent = unknown, TPayload = unknown> {
  readonly type: 'harness:stream';
  readonly id: string;
  readonly source: StreamSourceASTNode<TEvent>;
  readonly filterFn?: (event: TEvent) => boolean;
  readonly signal: SignalNode<TPayload>;
  readonly mapPayload: (event: TEvent) => TPayload;
}

export type PoolStrategyNode<TItem = unknown> =
  | {
      readonly type: 'harness:pool-strategy';
      readonly id: string;
      readonly strategyKind: 'soonest-reset' | 'round-robin' | 'least-used';
    }
  | {
      readonly type: 'harness:pool-strategy';
      readonly id: string;
      readonly strategyKind: 'escalate-on-retry';
      readonly minSuccessRate?: number;
      readonly minSamples?: number;
    }
  | {
      readonly type: 'harness:pool-strategy';
      readonly id: string;
      readonly strategyKind: 'custom';
      readonly selectFn: PoolSelectorFn<TItem>;
    };

export interface PoolNode<TItem = unknown> {
  readonly type: 'harness:pool';
  readonly id: string;
  readonly items: readonly TItem[];
  readonly strategy: PoolStrategyNode<TItem>;
  readonly fallbackItem?: TItem;
}

export interface PrefixGroupNode {
  readonly type: 'harness:prefix-group';
  readonly id: string;
  readonly toolsMode: 'role-scoped' | 'union';
  readonly sharedGrounding: readonly SourceValue<string>[];
  readonly sharedInstructions: readonly SourceValue<string>[];
  readonly sharedRules?: RulesNode;
}

export interface TopologyNode<TPartition extends string = string> {
  readonly type: 'harness:topology';
  readonly id: string;
  readonly store: TopologyStoreASTNode;
  readonly partitions: Readonly<Record<TPartition, { readonly dependsOn?: readonly TPartition[] }>>;
  readonly commitOverlayWhen?: {
    readonly onSignal?: {
      readonly signal: SignalNode<any>;
      readonly correlateBy: (sig: any) => string;
      readonly baseBranch?: (sig: any) => string;
    };
    readonly discardOnSignal?: {
      readonly signal: SignalNode<any>;
      readonly correlateBy: (sig: any) => string;
    };
    readonly maxSealedAgeHours?: number;
  };
}

export type ScopedRuleNode =
  | {
      readonly type: 'harness:scoped-rule';
      readonly id: string;
      readonly source?: undefined;
      readonly when: ScopePredicate;
      readonly directive: SourceValue<string>;
      readonly enforceBeforeStopChecks: readonly CheckASTNode<any>[];
    }
  | {
      readonly type: 'harness:scoped-rule';
      readonly id: string;
      readonly source: SourceASTNode<ScopedRule>;
      readonly when?: ScopePredicate;
      readonly directive?: SourceValue<string>;
      readonly enforceBeforeStopChecks: readonly CheckASTNode<any>[];
    };

export interface RulesNode {
  readonly type: 'harness:rules';
  readonly id: string;
  readonly globalRules: readonly SourceValue<GlobalRule | readonly GlobalRule[]>[];
  readonly scopedRules: ReadonlyArray<ScopedRuleNode | SourceValue<ScopedRule | readonly ScopedRule[]>>;
}

export type SkillNode<THandle = unknown> =
  | {
      readonly type: 'harness:skill';
      readonly id: string;
      readonly source?: undefined;
      readonly when?: ScopePredicate;
      readonly description: string;
      readonly instructions: SourceValue<string>;
      readonly unlockedTools: readonly ToolASTNode<THandle>[];
      readonly unlockedServices: readonly ServiceASTNode<THandle>[];
      readonly leaseMode: 'until-completed-or-fork-exit';
    }
  | {
      readonly type: 'harness:skill';
      readonly id: string;
      readonly source: SourceASTNode<SkillNode<THandle>>;
      readonly when?: ScopePredicate;
      readonly description?: string;
      readonly instructions?: SourceValue<string>;
      readonly unlockedTools: readonly ToolASTNode<THandle>[];
      readonly unlockedServices: readonly ServiceASTNode<THandle>[];
      readonly leaseMode: 'until-completed-or-fork-exit';
    };

export interface LessonsNode<TIn = unknown> {
  readonly type: 'harness:lessons';
  readonly id: string;
  readonly store: LessonStoreASTNode;
  readonly querySchema?: z.ZodType<TIn>;
  readonly queryMapper?: (input: TIn) => string;
  readonly distillation?: {
    readonly model: ModelASTNode | PoolNode<ModelASTNode>;
    readonly onLoopRecovery: boolean;
    readonly onGateRecovery?: { readonly minFailedChecks: number };
    readonly guidelines?: SourceValue<string>;
  };
  readonly scoring: {
    readonly slidingWindowInjections: number;
    readonly partitionMatchBoost: number;
    readonly decayOnPartitionEpochChange: number;
    readonly recall: { readonly minScore: number; readonly maxItems: number };
  };
  readonly retireAfter?: {
    readonly maxViolations?: number;
    readonly minCleanPassRate?: { readonly minRate: number; readonly afterInjections: number };
  };
  readonly emitSignalTriggers: ReadonlyArray<{
    readonly signal: SignalNode<any>;
    readonly minCleanPasses: number;
    readonly maxViolations: number;
    readonly cooldownHours: number;
    readonly mapPayload: (lesson: LessonRecord) => unknown;
  }>;
}

export interface PolicyViolation {
  readonly blockedCalls: readonly PendingPreFlightCall[];
  readonly violatedEffects: readonly ToolEffect[];
  readonly violationSummary: string;
}

export type PolicyGuardClauseNode =
  | {
      readonly type: 'harness:policy-guard-clause';
      readonly id: string;
      readonly guards: readonly PolicyGuardASTNode[];
      readonly mode: 'deny-with-error';
      readonly messageMapper?: (violation: PolicyViolation) => string;
    }
  | {
      readonly type: 'harness:policy-guard-clause';
      readonly id: string;
      readonly guards: readonly PolicyGuardASTNode[];
      readonly mode: 'raise-interrupt';
      readonly interrupt: InterruptNode<any>;
      readonly mapViolation: (violation: PolicyViolation) => unknown;
    };

export interface PolicyNode<THandle = unknown> {
  readonly type: 'harness:policy';
  readonly id: string;
  readonly clauses: readonly PolicyGuardClauseNode[];
  readonly tripwires: readonly QuotaTripwireASTNode[];
  readonly maxTurns?: number;
  readonly maxCostUsd?: number;
  readonly maxDurationSeconds?: number;
  readonly abortHook?: AbortHookASTNode<THandle, any>;
  readonly onLimitExceeded?: {
    readonly flushInterrupt: InterruptNode<any>;
    readonly abortHook?: AbortHookASTNode<THandle, any>;
  };
}

export interface HumanNode<
  TMode extends 'bidirectional' | 'notify-only' = 'bidirectional' | 'notify-only',
> {
  readonly type: 'harness:human';
  readonly id: string;
  readonly keepAliveSeconds?: number;
  readonly channel: HumanChannelASTNode<TMode>;
}

export interface ScopedHumanTargetNode<TResponse = unknown> {
  readonly type: 'harness:scoped-human';
  readonly human: HumanNode<'bidirectional'>;
  readonly alias: string;
  readonly outputSchema: z.ZodType<TResponse>;
}

export interface CompactionConfigNode {
  readonly type: 'harness:compaction';
  readonly signalTriggers: ReadonlyArray<{
    readonly signal: SignalNode<any>;
    readonly correlateBy: (sig: any) => string;
    readonly afterGracePeriodHours: number;
  }>;
  readonly terminalExitTriggers: ReadonlyArray<{
    readonly states: readonly string[];
    readonly afterGracePeriodHours: number;
  }>;
  readonly retainFailedRunsForDays?: number;
}

export interface CommandNode<TIn = unknown, TOut = unknown, THandle = unknown> {
  readonly type: 'harness:command';
  readonly id: string;
  readonly inputSchema: z.ZodType<TIn>;
  readonly outputSchema: z.ZodType<TOut>;
  readonly extractPartitions?: (input: TIn) => readonly string[];
  // Passive configuration callback invoked by the runtime's executeCommand NodeExecutor;
  // CommandNode never executes itself (command.execute does not exist).
  readonly fn: (input: TIn, ctx: ExecutionContext<THandle>) => Promise<TOut>;
}

export interface ForkCapabilityNode<
  TParentIn = any,
  TReq = any,
  TChildIn = any,
  TChildOut = any,
  THandle = any,
> {
  readonly type: 'harness:fork-capability';
  readonly toolName: string;
  readonly childExecutable:
    | AgentNode<TChildIn, TChildOut, THandle>
    | LoopNode<TChildIn, TChildOut, THandle, any>;
  readonly historyMode: 'shared-prefix-only' | 'clone-transcript';
  readonly requestSchema: z.ZodType<TReq>;
  readonly mapInput: (parentInput: TParentIn, req: TReq) => TChildIn;
  readonly modelRouting?: {
    readonly inheritParentEffort?: {
      readonly effort: 'low' | 'medium' | 'high';
      readonly when: (parentInput: TParentIn, req: TReq) => boolean;
    };
    readonly otherwisePool: ModelASTNode | PoolNode<ModelASTNode>;
  };
}

export interface SpeculateCapabilityNode<
  TParentIn = any,
  TReq = any,
  TChildIn = any,
  TChildOut = any,
  THandle = any,
  TCrossReport = any,
  TVerdict = any,
> {
  readonly type: 'harness:speculate-capability';
  readonly toolName: string;
  readonly requestSchema: z.ZodType<TReq>;
  readonly workerExecutable:
    | AgentNode<TChildIn, TChildOut, THandle>
    | LoopNode<TChildIn, TChildOut, THandle, any>;
  readonly branchCount: number;
  readonly mapBranches: (parentInput: TParentIn, req: TReq) => readonly TChildIn[];
  readonly crossVerifier?: CrossVerifierASTNode<THandle, any, TCrossReport>;
  readonly verifyWinnerWith?: {
    readonly evaluator: AgentNode<any, any, THandle>;
    readonly mapInput: (branchInput: TChildIn, branchOutput: TChildOut, scopeReceipt: any) => unknown;
    readonly acceptWhen: (evalOut: any) => boolean;
  };
  readonly arbiter: {
    readonly actor: AgentNode<any, TVerdict, THandle>;
    readonly resolveDecision: (verdict: TVerdict) =>
      | { readonly decision: 'select-winner'; readonly winnerBranchIndex: number }
      | { readonly decision: 'unpark-escalation'; readonly parkedBranchIndex: number; readonly rationale: string }
      | { readonly decision: 'reject-all'; readonly rationale: string };
  };
  readonly refineWinnerWhen?: {
    readonly predicate: (verdict: TVerdict) => boolean;
    readonly refinementExecutable:
      | AgentNode<TChildIn, TChildOut, THandle>
      | LoopNode<TChildIn, TChildOut, THandle, any>;
    readonly mapInput: (parentInput: TParentIn, verdict: TVerdict, candidates: readonly any[]) => TChildIn;
  };
}

export interface MutatePlanCapabilityNode<TItem = any> {
  readonly type: 'harness:mutate-plan-capability';
  readonly spawnTasks?: {
    readonly itemSchema: z.ZodType<TItem>;
    readonly maxSpawnedPerRun: number;
    readonly maxPrerequisiteDepth: number;
    readonly enforcePatch?: Partial<TItem>;
    readonly onPrerequisiteSpawned: 'suspend-and-yield-slot';
    readonly priorityStrategy: 'inherit-parent-with-boost' | 'normal';
    readonly resumeWhen:
      | 'prerequisite-exit'
      | { readonly signal: SignalNode<any>; readonly correlateBy: (sig: any) => string };
  };
  readonly canAddDependencies: boolean;
  readonly topologyToUpdate?: TopologyNode;
}

export interface EscalateCapabilityNode<TPayload = any, TResponse = any> {
  readonly type: 'harness:escalate-capability';
  readonly interrupt: InterruptNode<TPayload>;
  readonly human: HumanNode<'bidirectional'>;
  readonly responseSchema: z.ZodType<TResponse>;
  readonly elevateLeaseWhen?: {
    readonly predicate: (decision: TResponse) => boolean;
    readonly leaseMapper: (decision: TResponse) => LeaseDelta;
  };
}

export interface AgentCapabilitiesNode<TParentIn = any, THandle = any> {
  readonly type: 'harness:agent-capabilities';
  readonly forks: readonly ForkCapabilityNode<TParentIn, any, any, any, THandle>[];
  readonly speculations: readonly SpeculateCapabilityNode<TParentIn, any, any, any, THandle, any, any>[];
  readonly mutatePlan?: MutatePlanCapabilityNode<any>;
  readonly escalations: readonly EscalateCapabilityNode<any, any>[];
}

export interface ChildInterruptHandlerNode<TPayload = any> {
  readonly type: 'harness:child-interrupt-handler';
  readonly interrupt: InterruptNode<TPayload>;
  readonly pauseSiblingForksInPartitions?: (payload: TPayload) => readonly string[];
  readonly mode: 'suspend-and-return-to-parent';
}

export type InterruptHandlerNode<TIn = any, TPayload = any, THandle = any> =
  | {
      readonly type: 'harness:interrupt-handler';
      readonly mode: 'adjudicate';
      readonly interrupt: InterruptNode<TPayload>;
      readonly adjudicator: StepASTNode<any, any, THandle>;
      readonly mapInput: (input: TIn, payload: TPayload) => unknown;
      readonly onInterruptHandlers: readonly InterruptHandlerNode<any, any, THandle>[];
      readonly elevateLeaseWhen?: {
        readonly predicate: (input: TIn, payload: TPayload, verdict: any) => boolean;
        readonly leaseMapper: (input: TIn, payload: TPayload, verdict: any) => LeaseDelta;
      };
      readonly resumeWith: (input: TIn, payload: TPayload, verdict: any) => string;
    }
  | {
      readonly type: 'harness:interrupt-handler';
      readonly mode: 'ask';
      readonly interrupt: InterruptNode<TPayload>;
      readonly human: HumanNode<'bidirectional'>;
      readonly responseSchema: z.ZodTypeAny;
      readonly elevateLeaseWhen?: {
        readonly predicate: (decision: any) => boolean;
        readonly leaseMapper: (decision: any) => LeaseDelta;
      };
      readonly resumeWith: (decision: any) => string;
    }
  | {
      readonly type: 'harness:interrupt-handler';
      readonly mode: 'replace';
      readonly interrupt: InterruptNode<TPayload>;
      readonly abortHook?: AbortHookASTNode<THandle, any>;
      readonly replacementExecutable: StepASTNode<any, any, THandle>;
      readonly mapReplacementInput: (
        input: TIn,
        payload: TPayload,
        telemetry: UniversalStepTelemetry<any, any>,
      ) => unknown;
    };

export interface AgentNode<TIn = unknown, TOut = unknown, THandle = unknown> {
  readonly type: 'harness:agent';
  readonly id: string;
  readonly roleKey: string;
  readonly prefixGroup?: PrefixGroupNode;
  readonly model: ModelASTNode | PoolNode<ModelASTNode>;
  readonly topology?: TopologyNode;
  readonly rules?: RulesNode;
  readonly lessons?: { readonly node: LessonsNode<any>; readonly recordOutcomes: boolean };
  readonly skills: ReadonlyArray<SkillNode<THandle> | SourceASTNode<readonly SkillNode<THandle>[]>>;
  readonly policy?: PolicyNode<THandle>;
  readonly tools: readonly ToolASTNode<THandle>[];
  readonly grounding: readonly SourceValue<string>[];
  readonly instructions: readonly SourceValue<string>[];
  readonly timeoutMinutes?: number;
  readonly beforeStopChecks: readonly CheckASTNode<THandle>[];
  readonly inputSchema: z.ZodType<TIn>;
  readonly outputSchema: z.ZodType<TOut>;
  readonly extractPartitions?: (input: TIn) => readonly string[];
  readonly canRaiseInterrupts: readonly InterruptNode<any>[];
  readonly capabilities?: AgentCapabilitiesNode<TIn, THandle>;
  readonly onChildInterruptHandlers: readonly ChildInterruptHandlerNode<any>[];
  readonly onInterruptHandlers: readonly InterruptHandlerNode<TIn, any, THandle>[];
}

export interface LoopNode<
  TIn = unknown,
  TOut = unknown,
  THandle = unknown,
  TActStepId extends string = string,
> {
  readonly type: 'harness:loop';
  readonly id: string;
  readonly roleKey: string;
  readonly inputSchema: z.ZodType<TIn>;
  readonly outputSchema: z.ZodType<TOut>;
  readonly extractPartitions?: (input: TIn) => readonly string[];
  readonly maxIterations: number;
  readonly preserveActorSession: boolean;
  readonly distillLessons?: LessonsNode<any>;
  readonly actStep: {
    readonly stepId: TActStepId;
    readonly actor: AgentNode<TIn, TOut, THandle>;
  };
  readonly evaluateStep: {
    readonly stepId: string;
    readonly evaluator: AgentNode<any, any, THandle>;
    readonly mapInput: (loopInput: TIn, actOutput: TOut, scopeReceipt: any) => unknown;
    readonly acceptWhen: (evalOut: any) => boolean;
    readonly feedbackMapper: (evalOut: any) => string;
  };
  readonly returnOutputFromStepId: TActStepId;
}

export interface FlowStepNode<
  TIn = unknown,
  TOut = unknown,
  THandle = unknown,
  TStepId extends string = string,
> {
  readonly type: 'harness:flow-step';
  readonly id: TStepId;
  readonly step: StepASTNode<TIn, TOut, THandle>;
  readonly inputFrom?: (flowInput: any, priorSteps: Readonly<Record<string, any>>, scopeReceipt: any) => TIn;
  readonly onInterruptHandlers: readonly InterruptHandlerNode<any, any, THandle>[];
}

export interface FlowBranchNode<
  TFlowIn = unknown,
  TBranchOut = unknown,
  THandle = unknown,
  TBranchId extends string = string,
> {
  readonly type: 'harness:flow-branch';
  readonly id: TBranchId;
  readonly outputSchema: z.ZodType<TBranchOut>;
  readonly cases: ReadonlyArray<{
    readonly predicate: (input: TFlowIn) => boolean;
    readonly steps: ReadonlyArray<FlowStepNode<any, any, THandle> | FlowBranchNode<any, any, THandle>>;
  }>;
  readonly otherwiseSteps: ReadonlyArray<FlowStepNode<any, any, THandle> | FlowBranchNode<any, any, THandle>>;
}

export interface FlowNode<
  TIn = unknown,
  THandle = unknown,
  TStepIds extends string = string,
> {
  readonly type: 'harness:flow';
  readonly id: string;
  readonly inputSchema: z.ZodType<TIn>;
  readonly scope: IsolationScopeASTNode<THandle, any, any, any>;
  readonly telemetry?: TelemetryCollectorASTNode<any>;
  readonly nodes: ReadonlyArray<
    FlowStepNode<any, any, THandle, TStepIds> | FlowBranchNode<TIn, any, THandle, TStepIds>
  >;
  readonly exitState: string;
}

export interface LaneNode<
  TIn = unknown,
  TStepIds extends string = string,
> {
  readonly type: 'harness:lane';
  readonly id: string;
  readonly inputSchema: z.ZodType<TIn>;
  readonly keyMapper: (input: TIn) => string;
  readonly tracker?: {
    readonly adapter: TrackerASTNode<any, any>;
    readonly everySeconds: number;
    readonly fromIssue: (external: any) => TIn | undefined;
    readonly stateMappings: Readonly<Record<string, string>>;
  };
  readonly flow: FlowNode<TIn, any, TStepIds>;
  readonly concurrency: number;
  readonly priority: 'low' | 'normal' | 'high' | 'critical';
  readonly agingMinutes?: number;
  readonly waitFor?: {
    readonly depsMapper: (input: TIn) => readonly string[];
    readonly onAbandonedState: string;
  };
  readonly maxCostUsd?: {
    readonly limitUsd: number;
    readonly approver: ScopedHumanTargetNode<z.infer<typeof BudgetApprovalSchema>>;
  };
  readonly retry?: {
    readonly tries: number;
    readonly exponentialBaseMs: number;
    readonly orFailState: string;
  };
  readonly onSignalHandlers: ReadonlyArray<{
    readonly signal: SignalNode<any>;
    readonly updateMapper: (current: TIn, payload: any) => TIn;
    readonly rewindToStepId: TStepIds;
    readonly onRewind?: ScopeRewindHookASTNode<any>;
  }>;
}

export interface HarnessNode {
  readonly type: 'harness:root';
  readonly id: string;
  readonly ledger: LedgerStoreASTNode;
  readonly pools: ReadonlyArray<PoolNode<any> | RunnerPoolASTNode>;
  readonly streams: readonly StreamNode<any, any>[];
  readonly lanes: readonly LaneNode<any, any>[];
  readonly onSignalNotifications: ReadonlyArray<{
    readonly signal: SignalNode<any>;
    readonly human: HumanNode;
    readonly messageMapper: (payload: any) => string;
  }>;
  readonly exposedControlPlanes: readonly ControlPlaneASTNode[];
}

export type CoreASTNode =
  | HarnessNode
  | LaneNode
  | FlowNode
  | FlowStepNode
  | FlowBranchNode
  | AgentNode
  | LoopNode
  | CommandNode
  | PolicyNode
  | PolicyGuardClauseNode
  | ForkCapabilityNode
  | SpeculateCapabilityNode
  | MutatePlanCapabilityNode
  | EscalateCapabilityNode
  | AgentCapabilitiesNode
  | ChildInterruptHandlerNode
  | InterruptHandlerNode
  | PoolNode
  | PoolStrategyNode
  | TopologyNode
  | RulesNode
  | ScopedRuleNode
  | SkillNode
  | LessonsNode
  | PrefixGroupNode
  | SignalNode
  | InterruptNode
  | StreamNode
  | HumanNode
  | ScopedHumanTargetNode
  | CompactionConfigNode
  | EnvRef;

// ============================================================================
// 2.2 Domain-Agnostic Base AST Node Contracts & Workspace Category Unions
// ============================================================================

export type ScopeCapabilityTier = 'scope' | 'checkpointable' | 'branchable';

export interface BaseIsolationScopeASTNode<
  TType extends string = string,
  THandle = unknown,
  TReceipt extends Record<string, unknown> = Record<string, unknown>,
  TSync extends Record<string, unknown> = Record<string, unknown>,
  TTier extends ScopeCapabilityTier = ScopeCapabilityTier,
> {
  readonly type: TType;
  readonly id: string;
  readonly capabilityTier: TTier;
  readonly supportsCheckpoints: [TTier] extends ['checkpointable' | 'branchable'] ? true : false;
  readonly supportsBranching: [TTier] extends ['branchable'] ? true : false;
  readonly receiptSchema: z.ZodType<TReceipt>;
  readonly syncSchema?: z.ZodType<TSync>;
  readonly conflictCleanCheck?: CheckASTNode<THandle>;
  readonly __handleBrand?: THandle;
}

export interface BaseDomainStepASTNode<
  TType extends string = string,
  TIn = unknown,
  TOut = unknown,
  THandle = unknown,
> {
  readonly type: TType;
  readonly id: string;
  readonly inputSchema: z.ZodType<TIn>;
  readonly outputSchema: z.ZodType<TOut>;
  readonly __handleBrand?: THandle;
}

export type BaseStepASTNode<
  TType extends string = string,
  TIn = unknown,
  TOut = unknown,
  THandle = unknown,
> = BaseDomainStepASTNode<TType, TIn, TOut, THandle>;

export interface BaseToolASTNode<
  TType extends string = string,
  TTracking extends 'declared' | 'subprocess-post-flight' = 'declared' | 'subprocess-post-flight',
  THandle = unknown,
> {
  readonly type: TType;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodTypeAny;
  readonly effectTracking: TTracking;
  readonly __handleBrand?: THandle;
}

export interface BaseCheckASTNode<TType extends string = string, THandle = unknown> {
  readonly type: TType;
  readonly id: string;
  readonly __handleBrand?: THandle;
}

export interface BaseServiceASTNode<TType extends string = string, THandle = unknown> {
  readonly type: TType;
  readonly id: string;
  readonly lifecycle: 'scope' | 'fork' | 'skill';
  readonly toolSchemas: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly inputSchema: z.ZodTypeAny;
  }>;
  readonly __handleBrand?: THandle;
}

export interface BasePolicyGuardASTNode<TType extends string = string> {
  readonly type: TType;
  readonly id: string;
}

export interface BaseQuotaTripwireASTNode<TType extends string = string> {
  readonly type: TType;
  readonly id: string;
}

export interface BaseTelemetryCollectorASTNode<
  TType extends string = string,
  TMetrics extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly type: TType;
  readonly id: string;
  readonly schema: z.ZodType<TMetrics>;
}

export interface BaseAbortHookASTNode<
  TType extends string = string,
  THandle = unknown,
  TAbortMeta extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly type: TType;
  readonly id: string;
  readonly metaSchema: z.ZodType<TAbortMeta>;
  readonly __handleBrand?: THandle;
}

export interface BaseScopeRewindHookASTNode<TType extends string = string, THandle = unknown> {
  readonly type: TType;
  readonly id: string;
  readonly resetsRunOverlay?: boolean;
  readonly __handleBrand?: THandle;
}

export interface BaseCrossVerifierASTNode<
  TType extends string = string,
  THandle = unknown,
  TReceipt extends Record<string, unknown> = Record<string, unknown>,
  TCrossReport = unknown,
> {
  readonly type: TType;
  readonly id: string;
  readonly reportSchema: z.ZodType<TCrossReport>;
  readonly __handleBrand?: THandle;
  readonly __receiptBrand?: TReceipt;
}

export interface BaseSourceASTNode<TType extends string = string, T = unknown> {
  readonly type: TType;
  readonly id: string;
  readonly __dataType?: T;
}

export interface BaseAccountSeatASTNode<TType extends string = string> {
  readonly type: TType;
  readonly id: string;
}

export interface BaseModelASTNode<
  TType extends string = string,
  TSeat extends AccountSeatASTNode = AccountSeatASTNode,
> {
  readonly type: TType;
  readonly alias: string;
  readonly modelId: string;
  readonly effort?: 'low' | 'medium' | 'high';
  readonly accountPool?: PoolNode<TSeat>;
}

export interface BaseLedgerStoreASTNode<TType extends string = string> {
  readonly type: TType;
  readonly compaction?: CompactionConfigNode;
}

export interface BaseTopologyStoreASTNode<TType extends string = string> {
  readonly type: TType;
}

export interface BaseLessonStoreASTNode<TType extends string = string> {
  readonly type: TType;
}

export interface BaseTrackerASTNode<
  TType extends string = string,
  TExternal = unknown,
  TExternalState extends string = string,
> {
  readonly type: TType;
  readonly __externalBrand?: TExternal;
  readonly __stateBrand?: TExternalState;
}

export interface BaseStreamSourceASTNode<TType extends string = string, TEvent = unknown> {
  readonly type: TType;
  readonly __eventBrand?: TEvent;
}

export interface BaseHumanChannelASTNode<
  TType extends string = string,
  TMode extends 'bidirectional' | 'notify-only' = 'bidirectional' | 'notify-only',
> {
  readonly type: TType;
  readonly interactionMode: TMode;
}

export interface BaseControlPlaneASTNode<TType extends string = string> {
  readonly type: TType;
}

export interface BaseEffectMatcherASTNode<TType extends string = string> {
  readonly type: TType;
  readonly id: string;
}

export interface BaseRunnerPoolASTNode<TType extends string = string> {
  readonly type: TType;
  readonly id: string;
  readonly slots: number;
  readonly maxDaemons: number;
}

// Open declaration-mergeable registry for custom third-party domain adapter AST nodes.
// When unaugmented, CustomDomainAST<K> evaluates to never (preserving 100% literal TUnion['type'] keys);
// peer packages (e.g. @paraharness/stripe, @paraharness/netsuite) augment CustomDomainASTRegistry via
// `declare module '@paraharness/core' { interface CustomDomainASTRegistry { ... } }`.
export interface CustomDomainASTRegistry {}

export type CustomDomainAST<K extends string> = K extends keyof CustomDomainASTRegistry
  ? CustomDomainASTRegistry[K]
  : never;

// Workspace-Wide Per-Category Domain AST Discriminated Unions (Concrete Package Nodes Declared in Section 4)
export type IsolationScopeASTNode<
  THandle = any,
  TReceipt extends Record<string, unknown> = any,
  TSync extends Record<string, unknown> = any,
  TTier extends ScopeCapabilityTier = ScopeCapabilityTier,
> = GitCowWorktreeNode<THandle, TReceipt, TSync> | CustomDomainAST<'scope'>;

export type DomainStepASTNode<TIn = any, TOut = any, THandle = any> =
  | LocalCommandNode<TIn, TOut, THandle>
  | LocalStreamCheckNode<THandle>
  | GitCommitAndPushNode<TIn>
  | GitMergeQueueNode<TIn, TOut>
  | GithubCreateOrUpdatePrNode<TIn, TOut, THandle>
  | CustomDomainAST<'step'>;

export type StepASTNode<TIn = any, TOut = any, THandle = any> =
  | AgentNode<TIn, TOut, THandle>
  | LoopNode<TIn, TOut, THandle, any>
  | CommandNode<TIn, TOut, THandle>
  | DomainStepASTNode<TIn, TOut, THandle>;

export type BuiltInToolASTNode<THandle = any> =
  | FsReadToolNode<THandle>
  | FsEditToolNode<THandle>
  | FsWriteToolNode<THandle>
  | FsGlobToolNode<THandle>
  | FsGrepToolNode<THandle>
  | LocalCommandToolNode<THandle>
  | LocalStreamCheckToolNode<THandle>
  | LocalServiceToolNode<THandle>
  | GitRefReaderToolNode<THandle>
  | GitCandidateComparisonToolNode<THandle>;

export type ToolASTNode<THandle = any> =
  | BuiltInToolASTNode<THandle>
  | CustomDomainAST<'tool'>;

export type BuiltInCheckASTNode<THandle = any> =
  | LocalStreamCheckNode<THandle>
  | LocalCommandCheckNode<THandle>
  | FsRegexCheckNode<THandle>
  | GitCleanWorkingTreeNode;

export type CheckASTNode<THandle = any> =
  | BuiltInCheckASTNode<THandle>
  | CustomDomainAST<'check'>
  | CustomDomainAST<'evaluator'>;

export type EvaluatorASTNode<THandle = any> = CheckASTNode<THandle>;

export type ServiceASTNode<THandle = any> =
  | LocalServiceNode
  | CustomDomainAST<'service'>;

export type BuiltInGuardASTNode =
  | FsProtectGuardNode
  | FsReadOnlyGuardNode
  | FsAllowOnlyGuardNode
  | FsRequireReadBeforeWriteGuardNode
  | FsScopedWriteGuardNode
  | FsSecretLiteralsGuardNode
  | FsWriteGuardNode
  | FsBoundaryGuardNode
  | NodeAllowBinariesNode
  | NodeDenyNetworkNode;

export type GuardASTNode<THandle = any> =
  | BuiltInGuardASTNode
  | CustomDomainAST<'guard'>
  | CustomDomainAST<'policyGuard'>;

export type PolicyGuardASTNode = GuardASTNode;

export type QuotaTripwireASTNode =
  | FsQuotaTripwireNode
  | CustomDomainAST<'quotaTripwire'>
  | CustomDomainAST<'tripwire'>;

export type TelemetryCollectorASTNode<TMetrics extends Record<string, unknown> = Record<string, unknown>> =
  | FsTelemetryCollectorNode
  | CustomDomainAST<'telemetryCollector'>
  | CustomDomainAST<'telemetry'>;

export type AbortHookASTNode<THandle = any, TAbortMeta extends Record<string, unknown> = Record<string, unknown>> =
  | GitSnapshotAndResetNode
  | CustomDomainAST<'abortHook'>;

export type ScopeRewindHookASTNode<THandle = any> =
  | GitKeepWorktreeNode
  | GitDiscardBranchNode
  | CustomDomainAST<'rewindHook'>;

export type PatchEquivalenceASTNode<TCrossReport = any> =
  | GitPatchEquivalenceNode<TCrossReport>
  | CustomDomainAST<'patchEquivalence'>;

export type CrossTesterASTNode<TCrossReport = any> =
  | GitPublicSurfaceCrossTesterNode<TCrossReport>
  | CustomDomainAST<'crossTester'>;

export type CrossVerifierASTNode<
  THandle = any,
  TReceipt extends Record<string, unknown> = Record<string, unknown>,
  TCrossReport = any,
> =
  | PatchEquivalenceASTNode<TCrossReport>
  | CrossTesterASTNode<TCrossReport>
  | CustomDomainAST<'crossVerifier'>;

export type SourceASTNode<T = any> =
  | FsTextSourceNode
  | FsGlobSourceNode
  | MarkdownFrontmatterSourceNode<T>
  | MarkdownSectionSourceNode<T>
  | SqliteRulesSourceNode
  | PostgresRulesSourceNode
  | CustomDomainAST<'source'>;

export type AccountSeatASTNode =
  | ClaudeAccountSeatNode
  | OpenAiAccountSeatNode
  | GeminiAccountSeatNode
  | CustomDomainAST<'accountSeat'>;

export type ModelASTNode =
  | ClaudeModelNode
  | OpenAiModelNode
  | GeminiModelNode
  | CustomDomainAST<'model'>;

export type LedgerStoreASTNode =
  | SqliteLedgerNode
  | PostgresLedgerNode
  | CustomDomainAST<'ledger'>;

export type TopologyStoreASTNode =
  | SqliteTopologyNode
  | PostgresTopologyNode
  | CustomDomainAST<'topology'>;

export type LessonStoreASTNode =
  | FsJsonlLessonStoreNode
  | SqliteLessonsNode
  | PostgresLessonsNode
  | CustomDomainAST<'lessons'>;

export type TrackerASTNode<TExternal = any, TExternalState extends string = string> =
  | GithubIssuesTrackerNode<TExternal, TExternalState>
  | CustomDomainAST<'tracker'>;

export type StreamSourceASTNode<TEvent = any> =
  | GithubWebhookStreamNode<TEvent>
  | CustomDomainAST<'streamSource'>;

export type HumanChannelASTNode<
  TMode extends 'bidirectional' | 'notify-only' = 'bidirectional' | 'notify-only',
> = Extract<
  SlackApproverNode | SlackNotifierNode | CustomDomainAST<'humanChannel'>,
  { readonly interactionMode: TMode }
>;

export type ControlPlaneASTNode =
  | NodeMcpStdioNode
  | NodeMcpSseNode
  | NodeHttpControlPlaneNode
  | SlackApproverNode
  | CustomDomainAST<'controlPlane'>;

export type EffectMatcherASTNode =
  | FsGlobMatcherNode
  | CustomDomainAST<'effectMatcher'>;

export type RunnerPoolASTNode =
  | NodeRunnerNode
  | CustomDomainAST<'runner'>;

export type DomainASTNode =
  | IsolationScopeASTNode
  | DomainStepASTNode
  | ToolASTNode
  | CheckASTNode
  | ServiceASTNode
  | PolicyGuardASTNode
  | QuotaTripwireASTNode
  | TelemetryCollectorASTNode
  | AbortHookASTNode
  | ScopeRewindHookASTNode
  | CrossVerifierASTNode
  | SourceASTNode
  | AccountSeatASTNode
  | ModelASTNode
  | LedgerStoreASTNode
  | TopologyStoreASTNode
  | LessonStoreASTNode
  | TrackerASTNode
  | StreamSourceASTNode
  | HumanChannelASTNode
  | ControlPlaneASTNode
  | EffectMatcherASTNode
  | RunnerPoolASTNode
  | FsPartitionMapNode;

// ============================================================================
// 2.3 Universal NodeExecutor, switch (node.type) Narrowing & Swappable Engine
// ============================================================================

export type NodeExecutor<
  TNode extends { readonly type: string } = ASTNode,
  TInput = unknown,
  TOutput = unknown,
  TContext = ExecutionContext,
> = (node: TNode, input: TInput, ctx: TContext) => TOutput | Promise<TOutput>;

export type NodeExecutorMap<
  TUnion extends { readonly type: string },
  TInput = unknown,
  TOutput = unknown,
  TContext = ExecutionContext,
> = {
  readonly [TNode in TUnion as TNode['type']]: NodeExecutor<TNode, TInput, TOutput, TContext>;
};

export interface RuntimeDriverContext {
  readonly registry: RuntimeExecutorRegistry;
  resolveEnv(value: string | EnvRef): string | undefined;
  getRunner(node: RunnerPoolASTNode): RunnerDriver;
}

export interface StepExecutionContext<THandle = unknown> extends ExecutionContext<THandle> {
  readonly registry: RuntimeExecutorRegistry;
}

// Core step executors implement the exact same NodeExecutor<TNode, TInput, TOutput, TContext> contract:
export declare const executeAgent: NodeExecutor<
  AgentNode<any, any, any>,
  unknown,
  unknown,
  StepExecutionContext<any>
>;

export declare const executeLoop: NodeExecutor<
  LoopNode<any, any, any, any>,
  unknown,
  unknown,
  StepExecutionContext<any>
>;

export const executeCommand: NodeExecutor<
  CommandNode<any, any, any>,
  unknown,
  unknown,
  StepExecutionContext<any>
> = async (node, input, ctx) => node.fn(input, ctx);

// Core step dispatch validates step boundary schemas, narrows StepASTNode via switch (node.type) for
// core steps, and dispatches any DomainStepASTNode via ctx.registry.steps[node.type] in default:
export const executeStepNode: NodeExecutor<
  StepASTNode<any, any, any>,
  unknown,
  unknown,
  StepExecutionContext<any>
> = async (node, input, ctx) => {
  const validatedInput = node.inputSchema.parse(input);
  let rawOutput: unknown;
  switch (node.type) {
    case 'harness:agent':
      rawOutput = await executeAgent(node, validatedInput, ctx);
      break;
    case 'harness:loop':
      rawOutput = await executeLoop(node, validatedInput, ctx);
      break;
    case 'harness:command':
      rawOutput = await executeCommand(node, validatedInput, ctx);
      break;
    default: {
      const domainExecutor = ctx.registry.steps[node.type] as NodeExecutor<
        typeof node,
        unknown,
        unknown,
        StepExecutionContext<any>
      >;
      rawOutput = await domainExecutor(node, validatedInput, ctx);
      break;
    }
  }
  return node.outputSchema.parse(rawOutput);
};

export interface StepRunOptions<THandle = unknown> {
  readonly registry:
    | Partial<RuntimeExecutorRegistry>
    | RuntimeExecutorRegistrySlice
    | readonly RuntimeExecutorRegistrySlice[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly scopeHandle?: THandle;
  readonly runId?: string;
  readonly signal?: AbortSignal;
}

export declare function runStep<TIn = unknown, TOut = unknown, THandle = unknown>(
  node: MaybeBuilder<StepASTNode<TIn, TOut, THandle>>,
  input: TIn,
  options: StepRunOptions<THandle>,
): Promise<TOut>;

export interface RuntimeExecutorRegistry {
  readonly steps: NodeExecutorMap<DomainStepASTNode, any, any, StepExecutionContext<any>>;
  readonly sources: NodeExecutorMap<
    SourceASTNode,
    void,
    { readonly content: any; readonly digest: string },
    ResolutionContext
  >;
  readonly checks: NodeExecutorMap<
    CheckASTNode,
    void,
    { readonly ok: boolean; readonly deficits: readonly string[] },
    StepExecutionContext<any>
  >;
  readonly abortHooks: NodeExecutorMap<
    AbortHookASTNode,
    { readonly handle: any; readonly runId: string; readonly stepExecId: string },
    Record<string, unknown>,
    StepExecutionContext<any>
  >;
  readonly rewindHooks: NodeExecutorMap<
    ScopeRewindHookASTNode,
    { readonly handle: any; readonly targetStepBaseScopeCheckpoint?: string },
    void,
    StepExecutionContext<any>
  >;
  readonly crossVerifiers: NodeExecutorMap<
    CrossVerifierASTNode,
    ReadonlyArray<{
      readonly branchIndex: number;
      readonly scopeHandle: any;
      readonly scopeReceipt: Record<string, unknown>;
    }>,
    Readonly<Record<number, unknown>>,
    StepExecutionContext<any>
  >;
  readonly services: NodeExecutorMap<
    ServiceASTNode,
    {
      readonly runId: string;
      readonly scopeKey: string;
      readonly scopeHandle: any;
    },
    ServiceSession<any>,
    RuntimeDriverContext
  >;
  readonly policyGuards: NodeExecutorMap<
    PolicyGuardASTNode,
    {
      readonly toolName: string;
      readonly proposedEffects: readonly ToolEffect[];
      readonly activeLeases: readonly LeaseDelta[];
    },
    {
      readonly allowed: boolean;
      readonly violatedEffects: readonly ToolEffect[];
      readonly violationSummary: string;
    },
    StepExecutionContext<any>
  >;
  readonly quotaTripwires: NodeExecutorMap<
    QuotaTripwireASTNode,
    {
      readonly accumulatedEffects: readonly ToolEffect[];
      readonly newEffects: readonly ToolEffect[];
    },
    {
      readonly tripped: boolean;
      readonly reason?: string;
    },
    StepExecutionContext<any>
  >;
  readonly telemetryCollectors: NodeExecutorMap<
    TelemetryCollectorASTNode,
    readonly ToolEffect[],
    Record<string, unknown>,
    StepExecutionContext<any>
  >;
  readonly effectMatchers: NodeExecutorMap<
    EffectMatcherASTNode,
    ToolEffect,
    boolean,
    StepExecutionContext<any>
  >;
  readonly tools: {
    readonly [TNode in ToolASTNode as TNode['type']]: ToolDriver<TNode, any>;
  };
  readonly runners: {
    readonly [TNode in RunnerPoolASTNode as TNode['type']]: (node: TNode) => RunnerDriver;
  };
  readonly scopes: {
    readonly [TNode in IsolationScopeASTNode as TNode['type']]: (
      node: TNode,
      ctx: RuntimeDriverContext,
    ) => IsolationScope<any, any> | CheckpointableScope<any, any> | BranchableScope<any, any, any>;
  };
  readonly models: {
    readonly [TNode in ModelASTNode as TNode['type']]: (
      node: TNode,
      ctx: RuntimeDriverContext,
    ) => ModelDriver;
  };
  readonly ledgers: {
    readonly [TNode in LedgerStoreASTNode as TNode['type']]: (
      node: TNode,
      ctx: RuntimeDriverContext,
    ) => LedgerStore;
  };
  readonly topologies: {
    readonly [TNode in TopologyStoreASTNode as TNode['type']]: (
      node: TNode,
      ctx: RuntimeDriverContext,
    ) => TopologyStore;
  };
  readonly lessons: {
    readonly [TNode in LessonStoreASTNode as TNode['type']]: (
      node: TNode,
      ctx: RuntimeDriverContext,
    ) => LessonStore;
  };
  readonly trackers: {
    readonly [TNode in TrackerASTNode as TNode['type']]: (
      node: TNode,
      ctx: RuntimeDriverContext,
    ) => TrackerAdapter<any, any>;
  };
  readonly streamSources: {
    readonly [TNode in StreamSourceASTNode as TNode['type']]: (
      node: TNode,
      ctx: RuntimeDriverContext,
    ) => StreamSource<any>;
  };
  readonly humanChannels: {
    readonly [TNode in HumanChannelASTNode as TNode['type']]: (
      node: TNode,
      ctx: RuntimeDriverContext,
    ) => HumanAdapter;
  };
  readonly controlPlanes: {
    readonly [TNode in ControlPlaneASTNode as TNode['type']]: (
      node: TNode,
      ctx: RuntimeDriverContext,
    ) => ControlPlaneAdapter;
  };
}

export interface HarnessRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly controller: HarnessRuntimeController;
}

export interface HarnessRuntimeOptions {
  readonly registry?: Partial<RuntimeExecutorRegistry>;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface HarnessExecutionEngine {
  createRuntime(
    harness: HarnessNode | AstBuilder<HarnessNode>,
    options?: HarnessRuntimeOptions,
  ): HarnessRuntime;
}

export interface FlowRunOptions {
  readonly registry:
    | Partial<RuntimeExecutorRegistry>
    | RuntimeExecutorRegistrySlice
    | readonly RuntimeExecutorRegistrySlice[];
  readonly ledger: MaybeBuilder<LedgerStoreASTNode>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly runId?: string;
  readonly laneId?: string;
  readonly itemKey?: string;
  readonly signal?: AbortSignal;
}

export declare function runFlow<TIn = unknown, THandle = unknown>(
  flow: MaybeBuilder<FlowNode<TIn, THandle, string>>,
  input: TIn,
  options: FlowRunOptions,
): Promise<FlowRunResult>;

// ============================================================================
// 2.4 Runtime Contexts, Tool Effects, Policy Guards, Tripwires & Services
// ============================================================================

export interface ResolutionContext {
  readonly runId: string;
  readonly activePartitions: readonly string[];
  readonly observedEffects: readonly ToolEffect[];
  // Optional active scope handle (e.g. GitWorktreeHandle) passed strictly when computing in-run
  // updatedGroundingDiffs for grounding files unlocked by the active actor's policy/leases;
  // harness control-plane definitions (.instructions(), .rules(), .skills(), .guidelines(), and
  // initial .sharedGrounding() prefix compilation) always resolve paths against the immutable host repository root.
  readonly scopeHandle?: unknown;
  resolveEnv(value: string | EnvRef): string | undefined;
}

// Domain-agnostic effect descriptor emitted by tools before/after execution
// or synthesized post-flight by CheckpointableScope.diffEffects().
// E.g. @paraharness/fs emits { kind: 'fs:effect', mutatesScope: mode === 'write', attributes: { mode: 'read' | 'write', paths: string[], existingPathsAtBaseRef?: string[], proposedContent?: Readonly<Record<string, string>> } }
// E.g. @paraharness/stripe emits { kind: 'billing:effect', mutatesScope: true, attributes: { op: 'refund', amountUsd: number } }
export interface ToolEffect {
  readonly kind: string;
  readonly mutatesScope?: boolean;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

// JSON-serializable capability lease persisted on ContinuationFrame in LedgerStore
export interface LeaseDelta {
  readonly type: 'harness:lease-delta';
  readonly id: string;
  readonly grantedMatchers: readonly EffectMatcherASTNode[];
}

export interface RunnerDriver {
  readonly id: string;
  withSlot<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  withDaemonSlot<T>(fn: (releaseDaemonSlot: () => void) => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export interface ExecutionContext<THandle = unknown> {
  readonly runId: string;
  readonly stepExecId: string;
  readonly scopeHandle: THandle;
  readonly scopeNode?: IsolationScopeASTNode<THandle, any, any, any>;
  readonly scope?:
    | IsolationScope<THandle, any>
    | CheckpointableScope<THandle, any>
    | BranchableScope<THandle, any, any>;
  readonly candidateHandles?: ReadonlyMap<number, THandle>;
  readonly activeServiceSessions?: ReadonlyMap<string, ServiceSession<THandle>>;
  readonly activePartitions: readonly string[];
  readonly activeLeases: readonly LeaseDelta[];
  readonly observedEffects: readonly ToolEffect[];
  readonly signal?: AbortSignal;
  readonly seededHistory?: readonly WireFrameRecord[];
  readonly resumeContinuationStack?: readonly ContinuationFrame[];
  resolveEnv(value: string | EnvRef): string | undefined;
  // Returns the runtime's memoized RunnerDriver instance keyed by node.id
  getRunner(node: RunnerPoolASTNode): RunnerDriver;
  recordEffects(effects: readonly ToolEffect[]): void;
}

export interface ToolDriver<TNode extends ToolASTNode<THandle> = ToolASTNode<any>, THandle = unknown> {
  // Static effect predictor for pure/known tools (node.effectTracking === 'declared').
  // MUST be omitted on arbitrary code-execution or subprocess tools (node.effectTracking === 'subprocess-post-flight',
  // e.g., local.command.asTool(), local.streamCheck.asTool(), and service interaction tools) so the runtime enforces CheckpointableScope post-flight diffing.
  describeEffects?(
    node: TNode,
    args: unknown,
    scopeHandle: THandle,
  ): readonly ToolEffect[] | Promise<readonly ToolEffect[]>;
  readonly execute: NodeExecutor<
    TNode,
    unknown,
    {
      readonly content: string;
      readonly isError?: boolean;
    },
    StepExecutionContext<THandle>
  >;
}

export interface ServiceSession<THandle = unknown> {
  readonly id: string;
  readonly tools: readonly ToolASTNode<THandle>[];
  invokeTool(
    toolName: string,
    args: unknown,
    ctx: StepExecutionContext<THandle>,
  ): Promise<{
    readonly content: string;
    readonly isError?: boolean;
  }>;
  stop(): Promise<void>;
}

// ============================================================================
// 2.5 Capability-Tiered Isolation Scope Runtime Drivers
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

// Tier 1 — Base Isolation Scope Runtime Driver (Resolved from IsolationScopeASTNode with capabilityTier: 'scope')
export interface IsolationScope<
  THandle = unknown,
  TReceipt extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly id: string;
  readonly receiptSchema: z.ZodType<TReceipt>;
  acquireRoot(runId: string): Promise<THandle>;
  // Reboot recovery: rebinds an existing root scope handle from persistent state / checkpoint
  reattachRoot(runId: string, checkpoint?: string): Promise<THandle>;
  inspect(handle: THandle): Promise<TReceipt>;
  release(handle: THandle): Promise<void>;
}

// Tier 2 — Checkpointable Scope Runtime Driver (Resolved from IsolationScopeASTNode with capabilityTier: 'checkpointable' | 'branchable')
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

// Tier 3 — Branchable Scope Runtime Driver (Resolved from IsolationScopeASTNode with capabilityTier: 'branchable')
export interface BranchableScope<
  THandle = unknown,
  TReceipt extends Record<string, unknown> = Record<string, unknown>,
  TSync extends Record<string, unknown> = Record<string, unknown>,
> extends CheckpointableScope<THandle, TReceipt> {
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
  // Optional domain-provided temporary lease covering unresolved conflict resources on handle
  // after forkChild, commitChild, syncChild, or syncRoot returns with unresolved conflicts.
  getConflictLease?(handle: THandle): LeaseDelta | undefined;
}

// ============================================================================
// 2.6 Model Driver, Unified Prefix Group & Session Forking Port
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
  // Keyed by tool callId when completeSkill(id) is called in a single- or multi-tool turn.
  // Never mutated in-place during same-model execution or same-model 'clone-transcript' forks
  // (preserving 100% KV-cache hit rate and Anthropic thinking signatures, OpenAI encrypted_content, and Gemini thoughtSignature fields); substituted only by prepareFork()
  // when escalating across distinct models (sourceModelId !== targetModelId).
  readonly compactedTombstones?: Readonly<Record<string, string>>;
}

export interface WireToolSchema {
  readonly name: string;
  readonly description: string;
  // Pure JSON-serializable JSON Schema object (compiled from Zod at AST build time) so
  // CompiledWirePrefix can be persisted losslessly in LedgerStore.compiledPrefixesJson.
  readonly inputJsonSchema: Readonly<Record<string, unknown>>;
}

export interface CompiledWirePrefix {
  readonly prefixGroupId: string;
  readonly toolsMode: 'role-scoped' | 'union';
  readonly systemPromptText: string;
  readonly systemDigest: string;
  // Run-start snapshots of .sharedGrounding() sources so in-run grounding diffs can be computed
  // deterministically across process restarts without mutating byte 0 of systemPromptText.
  readonly groundingSnapshots: ReadonlyArray<{
    readonly sourceId: string;
    readonly text: string;
    readonly digest: string;
  }>;
  // Keyed by canonical roleKey (e.g., actorId or "${baseActor.id}+tools:${sortedExtraToolNames.join(',')}") in 'role-scoped' mode,
  // or '*' for the byte-identical group union in 'union' mode.
  readonly wireToolSchemasByRoleKey: Readonly<Record<string, readonly WireToolSchema[]>>;
}

export interface ForkContext {
  readonly historyMode: 'shared-prefix-only' | 'clone-transcript';
  readonly parentChain: readonly WireFrameRecord[];
  readonly forkPointMessageId: string | null;
  readonly wirePrefix?: CompiledWirePrefix;
  readonly roleKey?: string;
  // Optional: omitted on same-actor P.loop cross-model escalations so prepareFork() does not
  // emit consecutive user frames ahead of feedbackMapper(evalResult).
  readonly childRoleContextFrameText?: string;
  // Populated on 'clone-transcript' downward forks when forkPointMessageId is an assistant turn
  // with tool_use blocks (1..k), allowing prepareFork() (in both substituteTombstones === false
  // and substituteTombstones === true branches) to iterate all toolCalls (1..k) on forkPointMessageId
  // and synthesize a single tool_result / function_call_output / functionResponse frame pairing every callId: using precedingCompletedResults
  // for (1..m), childRoleContextFrameText + childTaskPromptText for forkCallId, and
  // "[Dispatched/Deferred in parent turn]" for all other callIds in that turn.
  readonly forkCallId?: string;
  readonly siblingForkCallIds?: readonly string[];
  readonly precedingCompletedResults?: ReadonlyArray<{
    readonly callId: string;
    readonly content: string;
    readonly isError?: boolean;
  }>;
  readonly childTaskPromptText?: string;
}

export interface ModelDriver {
  readonly vendorId: 'anthropic' | 'openai' | 'google' | string;
  readonly vendor?: 'anthropic' | 'openai' | 'google' | string;
  invokeTurn(req: {
    readonly modelId: string;
    readonly accountConfig?: unknown;
    readonly effort?: 'low' | 'medium' | 'high';
    readonly toolChoice?: 'auto' | 'none';
    readonly wirePrefix?: CompiledWirePrefix;
    readonly roleKey?: string;
    readonly history: readonly WireFrameRecord[];
    readonly wireToolSchemas?: readonly WireToolSchema[];
    readonly outputSchema?: z.ZodTypeAny;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly wireFrame: Uint8Array;
    readonly canonical: CanonicalMessage;
    // Populated only on a final structured-output completion turn, which occurs if and only if
    // (!canonical.toolCalls || canonical.toolCalls.length === 0). rawWireFrame preserves vendor-specific
    // reasoning state (Anthropic thinking signature, OpenAI encrypted_content, Gemini thoughtSignature).
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
  // [LIMIT_EXCEEDED_FLUSH]) to either a role: 'tool' frame (targeting targetCallId when specified, or
  // the last tool_result / function_call_output / functionResponse block in the frame, optionally setting isError via opts.isError) or a plain
  // role: 'user' text frame (such as Case C [TOPOLOGY_SYNC_REVERIFY], beforeStop deficit feedback, or
  // P.loop evaluation feedback), updating both rawWireFrame and frame.canonical.
  appendToolResultNotes(
    frame: WireFrameRecord,
    notes: readonly string[],
    targetCallId?: string,
    opts?: { readonly isError?: boolean },
  ): Promise<WireFrameRecord>;
}

// ============================================================================
// 2.7 Storage Runtime Ports (Ledger, Continuation Stacks, Topology, Lessons)
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
  // Violation metadata passed to .onViolation('raise-interrupt', interrupt, mapper)
  readonly blockedCalls: readonly PendingPreFlightCall[];
  // Populated when a post-flight subprocess rollback or voluntary interrupt tool (.canRaise / .escalate)
  // triggers suspension at a specific callId whose result is resolved upon .resumeWith() or resumeFork.
  readonly activeInterruptCallId?: string;
  // Persisted when .resumeWith(feedback) begins draining remainingCalls so crash recovery retains feedback.
  readonly adjudicationFeedback?: string;
  // Single declaration-ordered queue of all unfinished tool calls (i..k) in the assistant turn.
  // Initialized at the start of every tool-calling turn and atomically shifted to completedResults
  // as each call finishes; iterated strictly in (i..k) declaration order on .resumeWith().
  readonly remainingCalls: ReadonlyArray<{
    readonly callId: string;
    readonly toolName: string;
    readonly argsJson: string;
    readonly blockedPreFlight?: boolean;
    readonly adjudicatedClauseIds?: readonly string[];
  }>;
}

// Discriminated pause-state union on agent-frame consolidating mutually-exclusive phase-specific pause payloads
export type AgentPauseState =
  | {
      readonly kind: 'active-turn';
      readonly inFlightPreToolCheckpoint?: string;
    }
  | {
      readonly kind: 'tool-batch';
      readonly pendingToolBatch: PendingToolBatch;
      readonly inFlightPreToolCheckpoint?: string;
    }
  | {
      readonly kind: 'before-stop-gate';
    }
  | {
      readonly kind: 'adjudication';
      readonly pendingToolBatch?: PendingToolBatch;
      readonly pendingAdjudication: {
        readonly interruptId: string;
        readonly interruptPayloadJson: string;
        readonly humanRequestId?: string;
        readonly adjudicatorStack?: readonly ContinuationFrame[];
      };
    }
  | {
      readonly kind: 'prerequisite-wait';
      readonly pendingToolBatch: PendingToolBatch;
    }
  | {
      readonly kind: 'interrupt-flush';
      readonly interruptId: string;
      readonly flushPromptInjected?: boolean;
      readonly flushedInterruptPayloadJson?: string;
      readonly abortMetaJson?: string;
    };

// Serialized tree-structured execution frame preserving composite P.loop, P.agent, active downward
// forks (.fork / resumeFork), and speculative tournaments (.speculate) across both upward interrupt
// suspensions (SuspendedForkRecord) and process crash recovery (LedgerStore).
export type ContinuationFrame =
  | {
      readonly kind: 'agent-frame';
      readonly agentId: string;
      readonly roleKey: string;
      readonly modelId: string;
      readonly stepExecId: string;
      readonly inputJson: string;
      readonly leafMessageId: string | null;
      readonly turnsTaken: number;
      readonly costUsd: number;
      readonly elapsedDurationMs: number;
      readonly activeLeases: readonly LeaseDelta[];
      readonly activeSkillIds: readonly string[];
      readonly activeSkillActivations: Readonly<Record<string, { readonly messageId: string; readonly callId: string }>>;
      readonly observedEffects: readonly ToolEffect[];
      readonly injectedScopedRuleIds: readonly string[];
      readonly pausedAtPhase: 'TOOL_BOUNDARY' | 'BEFORE_STOP_GATE' | 'LIMIT_EXCEEDED_FLUSH';
      readonly pauseState: AgentPauseState;
      // Turn/session-spanning accumulators kept exclusively at the top level of agent-frame:
      readonly conflictCheckArmed?: boolean;
      readonly neutralSyncContinuation?: boolean;
      // Set during 'SUSPENDED' wakeup once syncRoot/failure note is persisted; cleared on suspension and after wakeup remainingCalls drain
      readonly syncedToPrerequisiteCheckpoint?: string;
      readonly lastGateFailureJson?: string;
      readonly bufferedGateRecoveries?: ReadonlyArray<unknown>;
      readonly accumulatedLessonOutcomes?: Readonly<Record<string, LessonOutcome>>;
    }
  | {
      readonly kind: 'loop-frame';
      readonly loopId: string;
      readonly roleKey: string;
      readonly lastActModelId?: string;
      readonly stepExecId: string;
      readonly loopInputJson: string;
      readonly iteration: number;
      readonly phase: 'act' | 'evaluate';
      readonly preservedActLeafMessageId: string | null;
      // Persisted when transitioning from phase: 'act' to phase: 'evaluate' so crash recovery mid-evaluation retains both
      readonly lastActOutputJson?: string;
      readonly lastActScopeReceiptJson?: string;
      // Cumulative total loop counters across both .act() and .evaluate() for UniversalStepTelemetry
      readonly turnsTaken: number;
      readonly costUsd: number;
      readonly elapsedDurationMs: number;
      // Cumulative .act()-only counters evaluated by quantitative P.policy tripwires on the .act() actor
      readonly actTurnsTaken: number;
      readonly actCostUsd: number;
      readonly actElapsedDurationMs: number;
      // Loop-level lease, .act()-scoped skill, effect, and scoped-rule accumulators: persist across Iteration k+1
      // (including across step-boundary daemon quiescing, cross-model escalations, and sibling-interrupt rollbacks).
      // Note: activeSkillIds and activeSkillActivations on loop-frame are scoped strictly to the .act() actor;
      // the .evaluate() actor manages its own ephemeral agent-frame.activeSkillIds during evaluation.
      readonly grantedLoopLeases: readonly LeaseDelta[];
      readonly activeSkillIds: readonly string[];
      readonly activeSkillActivations: Readonly<Record<string, { readonly messageId: string; readonly callId: string }>>;
      readonly observedEffects: readonly ToolEffect[];
      readonly injectedScopedRuleIds: readonly string[];
      readonly conflictCheckArmed?: boolean;
      readonly recalledLessons: ReadonlyArray<{
        readonly id: string;
        readonly partition?: string;
        readonly directive: string;
      }>;
      readonly lastRejectedIterationJson?: string;
      readonly bufferedGateRecoveries?: ReadonlyArray<unknown>;
      // Per-loop deduplicated lesson outcome tracker: lessonId -> worst 4-state outcome observed so far
      readonly accumulatedLessonOutcomes: Readonly<Record<string, LessonOutcome>>;
    }
  | {
      readonly kind: 'fork-batch-frame';
      readonly parentStepExecId: string;
      readonly pendingPauseTriggers?: ReadonlyArray<{
        readonly triggeredByForkId: string;
        readonly interruptId: string;
        readonly interruptPayloadJson: string;
        readonly affectedPartitions: readonly string[];
      }>;
      readonly forks: ReadonlyArray<{
        readonly forkId: string;
        readonly suspendedForkId?: string; // Set when resuming a prior SuspendedForkRecord via resumeFork
        readonly callId: string;
        readonly toolName: string;
        readonly activePartitions: readonly string[];
        readonly status: 'RUNNING' | 'CHILD_COMMITTED' | 'COMPLETED' | 'SUSPENDED' | 'FAILED' | 'ABORTED';
        readonly conflictRetryCount: number;
        readonly conflictCheckArmed: boolean;
        readonly suspensionEpoch: number;
        readonly syncedToParentCheckpoint?: string;
        readonly syncResultJson?: string;
        readonly resumeFrameInjected?: boolean;
        readonly childScopeCheckpoint?: string;
        readonly outputJson?: string;
        readonly committedReceiptJson?: string;
        readonly toolResultJson?: string;
        readonly lessonsFlushed?: boolean;
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
      readonly conflictRetryCount: number;
      readonly conflictCheckArmed: boolean;
      readonly lessonsFlushed?: boolean;
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
      // Buffered per-branch lesson outcomes flushed to LessonStore only after WINNER_COMMITTED is recorded
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
  readonly triggeredByForkId?: string;
  readonly raisedByPhase?: 'act' | 'evaluate';
  readonly conflictRetryCount: number;
  readonly conflictCheckArmed: boolean;
  readonly syncedToParentCheckpoint?: string;
  readonly syncResultJson?: string;
  readonly resumeFrameInjected?: boolean;
  readonly interruptId?: string;
  readonly interruptPayloadJson?: string;
  readonly suspendedAtCallId?: string;
  readonly childScopeCheckpoint?: string;
  // Ordered outer-to-inner (e.g., [loop-frame(verified-worker-loop), agent-frame(guardedWorker)])
  readonly continuationStack: readonly ContinuationFrame[];
}

export interface LedgerStore {
  createOrResumeRun(run: {
    readonly runId: string;
    readonly laneId: string;
    readonly itemKey: string;
    readonly inputJson: string;
    readonly compiledPrefixesJson?: Readonly<Record<string, string>>; // prefixGroupId -> JSON-serialized CompiledWirePrefix pinned at run start
    readonly costUsd?: number;
    readonly approvedMaxCostUsd?: number;
  }): Promise<{
    readonly status: string;
    readonly currentStepId: string | null;
    readonly inputJson: string;
    readonly rewindPendingToStepId?: string;
    readonly compiledPrefixesJson?: Readonly<Record<string, string>>;
    readonly costUsd: number;
    readonly approvedMaxCostUsd?: number;
    readonly completedStepOutputsJson: ReadonlyMap<string, string>; // stepId -> outputJson for .inputFrom() recovery
  }>;
  recordStepStart(step: {
    readonly stepExecId: string;
    readonly runId: string;
    readonly stepId: string;
    readonly executableId?: string;
    readonly inputMsgId: string | null;
    readonly baseScopeCheckpoint?: string;
    readonly continuationStack: readonly ContinuationFrame[];
  }): Promise<void>;
  // All updates for a given stepExecId are serialized through a per-step async queue in @paraharness/core
  // (including activeLeases / grantedLoopLeases updates and concurrent child fork frame transitions).
  updateContinuationStack(
    runId: string,
    stepExecId: string,
    continuationStack: readonly ContinuationFrame[],
    opts?: { readonly baseScopeCheckpoint?: string },
  ): Promise<void>;
  updateRunInput(
    runId: string,
    update: { readonly inputJson: string; readonly rewindPendingToStepId?: string | null },
  ): Promise<void>;
  mutateLanePlan(req: {
    readonly laneId: string;
    readonly parentRunId: string;
    readonly parentItemKey: string;
    readonly maxPrerequisiteDepth: number;
    readonly spawnedItems?: ReadonlyArray<{
      readonly itemKey: string;
      readonly inputJson: string;
      readonly dependsOn: readonly string[];
      readonly priority: 'low' | 'normal' | 'high' | 'critical';
    }>;
    readonly addedDependencies?: readonly string[];
  }): Promise<void>;
  appendMessageFrame(runId: string, frame: WireFrameRecord): Promise<void>;
  replaceMessageFrame(runId: string, frame: WireFrameRecord): Promise<void>;
  markFrameTombstone(
    runId: string,
    messageId: string,
    callId: string,
    compactedTombstone: string,
  ): Promise<void>;
  getMessageChain(leafMessageId: string): Promise<readonly WireFrameRecord[]>;
  recordForkSuspension(record: SuspendedForkRecord): Promise<void>;
  getSuspendedForks(
    runId: string,
    opts?: { readonly forkIds?: readonly string[]; readonly parentStepExecId?: string },
  ): Promise<readonly SuspendedForkRecord[]>;
  resolveSuspendedFork(suspendedForkId: string, status: 'RESUMED' | 'ABORTED'): Promise<void>;
  recordStepTransition(transition: {
    readonly stepExecId: string;
    readonly status: 'RUNNING' | 'COMPLETED' | 'INTERRUPTED' | 'FAILED' | 'SUSPENDED';
    readonly outputJson?: string;
    readonly baseScopeCheckpoint?: string;
    readonly headScopeCheckpoint?: string;
    readonly telemetryJson: string;
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
  // Returns all non-terminal runs ('QUEUED' | 'RUNNING' | 'WAITING' | 'SUSPENDED') on boot, including runs mid-step
  // and runs that crashed between steps (during initial syncRoot, between Step i completion and
  // Step i+1 start, or during .replaceWith() abortHook, where stepExecId/stepId may be null).
  getInterruptedStepsOnBoot(): Promise<
    ReadonlyArray<{
      readonly runId: string;
      readonly laneId: string;
      readonly itemKey: string;
      readonly inputJson: string;
      readonly status: 'QUEUED' | 'RUNNING' | 'WAITING' | 'SUSPENDED';
      readonly dependsOn: readonly string[];
      readonly stepExecId: string | null;
      readonly stepId: string | null;
      readonly executableId?: string;
      readonly baseScopeCheckpoint?: string;
      readonly headScopeCheckpoint?: string;
      readonly continuationStack: readonly ContinuationFrame[];
    }>
  >;
  // Prunes raw WireFrameRecord payloads for a specific terminal runId (persisting compaction deadlines
  // in LedgerStore so timers survive restarts and never prune frames of a new active run for the same itemKey).
  compactRunFrames(runId: string): Promise<void>;
}

export interface TopologyPartitionState {
  readonly partitionId: string;
  readonly epoch: number;
  readonly contractText: string;
  readonly updatedAt: string;
  readonly lastMutatedByRunId?: string;
}

export interface TopologyStore {
  // Returns the partition graph for runId (merging any uncommitted per-run CoW overlay over the base store
  // and pinning each partition's initial baseContractTextAtAcquire when runId first loads the partition)
  getPartitions(runId?: string): Promise<ReadonlyMap<string, TopologyPartitionState>>;
  // Writes contract updates to runId's isolated CoW overlay (tagged with stepExecId for step-scoped rollback,
  // setting lastMutatedByRunId = runId [preserved across syncRunOverlays], and incrementing the partition's
  // overlay epoch at most once per (runId, partitionId): newEpoch = overlayAlreadyMutatedInRun ? currentOverlayEpoch : currentOverlayEpoch + 1,
  // unless reset by resetRunOverlay) so concurrent unmerged runs are never polluted
  updateContract(
    runId: string,
    partitionId: string,
    newContractText: string,
    stepExecId?: string,
  ): Promise<{ readonly newEpoch: number }>;
  // Merges prerequisite runs' overlays (ACTIVE or SEALED_UNMERGED) into targetRunId's overlay during
  // initial QUEUED->RUNNING start, syncRoot wakeup, or when a stacked PR merges into its prerequisite branch,
  // advancing targetRunId's 3-way merge-base text for each absorbed partition to the prerequisite's contractText
  // so stacked PR commits never false-conflict
  syncRunOverlays(targetRunId: string, prerequisiteRunIds: readonly string[]): Promise<void>;
  // When scope === 'step', resets uncommitted overlay mutations tagged with stepExecId from an aborted/retried
  // step (preserving overlay mutations from earlier COMPLETED steps); when scope === 'run' (e.g. git.resetWorktree()),
  // resets the entire run's uncommitted overlay mutations back to its synced prerequisite/run-start base
  resetRunOverlay(
    runId: string,
    opts?: { readonly scope?: 'step' | 'run'; readonly stepExecId?: string },
  ): Promise<void>;
  // Seals runId's overlay on flow exit 'done' when awaiting an external merge signal (so stacked dependents
  // can merge it via syncRunOverlays without polluting the base store for unrelated main-branched runs)
  sealRunOverlay(runId: string): Promise<void>;
  // Commits runId's overlay (and any ancestor/prerequisite SEALED_UNMERGED overlays absorbed via syncRunOverlays)
  // to the base store (allocating base.epoch = currentBase.epoch + 1 monotonically at commit time,
  // performing a 3-way contractText merge against baseContractTextAtAcquire, and returning the committedRunIds
  // and updatedEpochs map so LessonStore.syncCreationEpochsForRuns can align epochAtCreation), or discards it on abort / PR close
  commitRunOverlay(runId: string): Promise<{
    readonly committedRunIds: readonly string[];
    readonly updatedEpochs: ReadonlyMap<string, number>;
  }>;
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
  readonly createdByRunId?: string;
  readonly recentOutcomes: ReadonlyArray<LessonOutcome>;
  readonly totalCleanPasses: number;
  readonly totalViolated: number;
  // Normalized text similarity R(L, Q) in [0, 1] populated by LessonStore.queryCandidates()
  readonly relevanceScore?: number;
  // Persisted signalId -> ISO-8601 timestamp map enforcing .emitSignalWhen() cooldowns across restarts
  readonly signalLastEmittedAt?: Readonly<Record<string, string>>;
}

export interface LessonStore {
  queryCandidates(req: {
    readonly queryText: string;
    readonly partitions: readonly string[];
  }): Promise<readonly LessonRecord[]>;
  admit(lesson: {
    readonly partition?: string;
    readonly directive: string;
    readonly epochAtCreation: number;
    readonly createdByRunId?: string;
  }): Promise<string>;
  recordOutcomes(
    outcomes: ReadonlyArray<{ readonly lessonId: string; readonly outcome: LessonOutcome }>,
  ): Promise<ReadonlyArray<LessonRecord>>;
  syncCreationEpochsForRuns(
    runIds: readonly string[],
    updatedEpochs: ReadonlyMap<string, number>,
  ): Promise<void>;
  markSignalEmitted(lessonId: string, signalId: string, emittedAt: string): Promise<void>;
  retire(lessonIds: readonly string[]): Promise<void>;
}

// ============================================================================
// 2.8 External Tracker, Stream, Human & Control-Plane Runtime Ports
// ============================================================================

export interface TrackerAdapter<TExternal, TExternalState extends string = string> {
  poll(): Promise<readonly TExternal[]>;
  setExternalState(itemKey: string, state: TExternalState): Promise<void>;
}

export interface StreamSource<TEvent> {
  subscribe(onEvent: (event: TEvent) => Promise<void>): Promise<{ close(): Promise<void> }>;
}

export interface HumanAdapter {
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
  start(runtime: HarnessRuntimeController): Promise<{ close(): Promise<void> }>;
}

export interface HarnessRuntimeController {
  emitSignal<TPayload>(signalId: string, payload: TPayload): Promise<void>;
  getActiveRuns(): Promise<ReadonlyArray<{ runId: string; laneId: string; itemKey: string; status: string }>>;
}
~~~

---

# 3. `@paraharness/core` Primitives & Orchestration Semantics

## 3.1 Signals (`P.signal`), Interrupts (`P.interrupt`) & Event Streams (`P.stream`)

* **`P.signal(id).payload(zodSchema)`:** Compiles to `SignalNode<TPayload>` (`type: 'harness:signal'`). Represents an asynchronous event emitted by external streams, control-plane adapters, or internal threshold monitors. Signals route to harness notification handlers, topology overlay commit hooks, or ledger compaction hooks without unwinding execution call stacks, *except* when explicitly bound to a lane's `.onSignal(sig, $s => $s.rewindTo(stepId))` handler (which drains in-flight work and rewinds the run to `stepId`).
* **`P.interrupt(id).payload(zodSchema)`:** Compiles to `InterruptNode<TPayload>` (`type: 'harness:interrupt'`). Represents a synchronous upward exception raised voluntarily by an `P.agent` (via a structured interrupt tool call) or deterministically by an `P.policy` guard/tripwire. Raising an interrupt halts the active step and transfers control to the nearest enclosing `.onInterrupt()` or `.onChildInterrupt()` edge.
* **`P.stream(id).source(streamSource).filter(pred).emitSignal(signal, mapper)`:** Compiles to `StreamNode<TEvent, TPayload>` (`type: 'harness:stream'`). Binds a `StreamSourceASTNode<TEvent>` (resolved at runtime via `RuntimeExecutorRegistry.streamSources` to a `StreamSource<TEvent>`), filters incoming events synchronously, and emits correlated `P.signal` instances into the harness runtime.

## 3.2 Capacity Pools (`P.pool`), Unified Warm-Fork Prefixes (`P.prefixGroup`) & Deterministic Fork Routing

`P.pool` compiles to a passive `PoolNode<TItem>` (`type: 'harness:pool'`) that schedules concurrent access across account seats or models:

* **Account Pools & Run-Sticky Seat Affinity:** Multiplex across subscription seats (`strategy: 'soonest-reset' | 'round-robin' | 'least-used'`, or a custom `PoolStrategyNode<TItem>` / `PoolSelectorFn<TItem>`) and cascade to `.fallback(account)` when all primary seats are rate-limited. Once a `runId` acquires an account seat, all turns and child forks within that `runId` stick to that seat (preserving per-account Anthropic KV prefix caches, OpenAI `previous_response_id` server-side state, and Gemini prefix caches) unless that seat hits a `429`/quota exhaustion, in which case failover to another seat or `.fallback(account)` replays the full `WireFrameRecord[]` history (automatically stripping account-bound OpenAI `previous_response_id`, server item IDs `rs_...`/`fc_...`/`msg_...`, and org-keyed `encrypted_content` when failing over across distinct OpenAI accounts).
* **Model Pools & Custom Selection Strategies:** Track empirical completion rates per model in the ledger and escalate along the pool chain via `.strategy(($) => $.escalateOnRetry().minSuccessRate(r).minSamples(n))`, or select candidates via a custom `PoolStrategyNode<TItem>` (`{ type: 'harness:pool-strategy', id, strategyKind: 'custom', selectFn }`), a custom `PoolSelectorFn<TItem>` (`(candidates: readonly PoolCandidateState<TItem>[], ctx: PoolSelectionContext) => TItem | undefined`), or `.strategy(($) => $.custom(strategy))`.

~~~ts
export interface PoolCandidateState<TItem = unknown> {
  readonly item: TItem;
  readonly index: number;
  readonly id: string;
  readonly rateLimitedUntilMs?: number;
  readonly usageCount: number;
  readonly lastUsedAtMs?: number;
  readonly successCount: number;
  readonly sampleCount: number;
  readonly empiricalSuccessRate: number;
}

export interface PoolSelectionContext {
  readonly poolId: string;
  readonly runId: string;
  readonly retryAttempt: number;
  readonly nowMs: number;
  readonly stickyCandidateId?: string;
}

export type PoolSelectorFn<TItem = unknown> = (
  candidates: readonly PoolCandidateState<TItem>[],
  ctx: PoolSelectionContext,
) => TItem | undefined;
~~~

### 3.2.1 Run-Immutable Unified Warm-Fork Prefix Groups (`P.prefixGroup`)

Provider KV caches (Anthropic, OpenAI, and Google Gemini) key their prefix caches on `(model_id, wire_tools_array, system_prompt, messages[0..k])` across all requests within the cache TTL (using top-level `system` + `tools` for Anthropic, `instructions` + `tools` for OpenAI, and `systemInstruction` + `tools: [{ functionDeclarations }]` for Gemini).

~~~ts
export const engineeringPrefix = P.prefixGroup('engineering-prefix')
  .toolsMode('role-scoped') // Default: 'role-scoped'; optional 'union' for 'clone-transcript' forks
  .sharedGrounding(
    fs.text('PRODUCT_SPEC.md'),
    fs.text('TECH_DESIGN.md'),
  )
  .sharedInstructions(fs.text('.harness/prompts/base-posture.md'))
  .sharedRules(repoRules);
~~~

* **Declaration-Order Run-Start Pinning of Wire `system` Field & `groundingSnapshots`:** For every `P.agent` bound to `.prefixGroup(engineeringPrefix)`, the top-level wire `system` prompt concatenates the group's `.sharedGrounding(...)`, `.sharedInstructions(...)`, and global rules from `.sharedRules(...)` in strict **AST declaration order** (using `ctx.registry.sources[sourceNode.type](sourceNode, undefined, ctx)` to load `{ content, digest }` and compute `CompiledWirePrefix.systemDigest`). At the start of each flow run, `@paraharness/core` resolves and pins `CompiledWirePrefix` (including `groundingSnapshots` and `wireToolSchemasByRoleKey` with pure JSON-Schema `inputJsonSchema` objects) in `LedgerStore` (`createOrResumeRun().compiledPrefixesJson`). If an actor (such as `coordinator`) legitimately mutates a file referenced in `.sharedGrounding()` mid-run (e.g., `TECH_DESIGN.md` or, after an owner lease, `PRODUCT_SPEC.md`), the pinned wire `system` prompt is **never** mutated; instead, the runtime loads the current working copy via `ctx.registry.sources[sourceNode.type](sourceNode, undefined, { ...ctx, scopeHandle })` (which returns `{ content, digest }`), computes the diff against `CompiledWirePrefix.groundingSnapshots`, and injects that diff (`updatedGroundingDiffs`) into subsequent Turn-0 `[ROLE_AND_SCOPE_CONTEXT]` and `[TOPOLOGY_SYNC]` user frames.
* **Two Wire Tool Modes (`.toolsMode('role-scoped' | 'union')`):**
    * **`'role-scoped'` (Default, paired with `historyMode: 'shared-prefix-only'`):** Each actor or derived `.withTools()` clone (identified by its canonical, order-independent `roleKey`—derived by `.withTools(...extraTools)` as `roleKey = "${baseActor.id}+tools:${sortedExtraToolNames.join(',')}"` with mounted extra tool names sorted lexicographically, and persisted on `agent-frame` and `loop-frame`) transmits only its own declared `.tools()`, `.skills()` tool schemas, and `.capabilities()` tools (`wireToolSchemasByRoleKey[roleKey]`) alongside the shared `systemPromptText`. Because `'shared-prefix-only'` forks start a clean transcript at `messages[0]` and provider caches are content-addressed per `(model_id, tools, system)`, every `sonnet` worker achieves a 100% prefix cache hit across all `sonnet` worker invocations without paying token prefill overhead for—or being tempted to call—`coordinator`-only orchestration tools (`delegate-partition`, `explore-candidates`, `spawnTasks`, `resumeFork`).
    * **`'union'` (Required only when a member actor configures `.fork(..., $f => $f.historyMode('clone-transcript'))` across distinct roles):** At AST compilation time, `@paraharness/core` computes the deterministic, byte-identical union of tool schemas across all member actors in the `prefixGroup` (`wireToolSchemasByRoleKey['*']`, tagging role-restricted tools with a static `[Role: <actorId>]` suffix so `wireToolSchemas` never vary per caller). A child fork cloning the parent's `messages[0..k]` transcript retains 100% byte-identical `tools` and `system` blocks prior to `messages[0]`, while active role permissions are declared in `[ROLE_AND_SCOPE_CONTEXT]` and enforced pre-flight by the runtime role lease gate.
* **Turn-0 `[ROLE_AND_SCOPE_CONTEXT]` Frame:** Actor-specific `.instructions(...)` (such as `coordinator.md` vs `worker.md`), the catalog of all mounted `.skills(...)` `(skillId, description)` pairs (ensuring procedural skills without unlocked tools are discoverable via `activateSkill`), live `P.topology` partition contracts and epochs, in-run grounding diffs (`updatedGroundingDiffs`), partition-scoped rules, and recalled lessons are never placed in the wire `system` field. Instead, they are injected into the structured `[ROLE_AND_SCOPE_CONTEXT]` user message frame at Turn 0 of the session (`historyMode: 'shared-prefix-only'`) or at the transcript fork point (`historyMode: 'clone-transcript'`).

### 3.2.2 Deterministic Downward Fork Model Routing

Configuring `.modelRouting(($m) => $m.inheritParentWithEffort('medium', { when: (parentInput, toolReq) => boolean }).otherwisePool(pool))` on `.fork()` evaluates the deterministic `when` predicate over `(parentInput, toolReq)` (for example, `req.estimatedTurns <= 6`) to keep short forks on the parent model's weights with reduced reasoning effort while routing longer forks to `pool`.

## 3.3 Relational System Topology (`P.topology`)

`P.topology(id).store(topologyStore).partitions(record).commitOverlayWhen(opts?)` defines the directed graph of logical system partitions.

* **Pure Relational Graph:** Each partition key declares optional `dependsOn: readonly string[]` edges. Core `P.topology` has zero awareness of files or globs; domain packages (such as `@paraharness/fs`) map partitions to physical resources externally.
* **Run-Scoped Copy-on-Write Overlay, Monotonic 3-Way Signal-Correlated Commit & Turn-0 Injection:** The `TopologyStore` tracks an integer `epoch` and `contractText` per partition. When `getPartitions(runId)` is first loaded at the start of a run, `TopologyStore` pins each partition's initial 3-way merge base text (`baseContractTextAtAcquire`) from the base store. Subsequent contract mutations performed via `updatePartitionContract` are written to `runId`'s Copy-on-Write overlay (`TopologyStore.updateContract(runId, partitionId, newContractText, stepExecId)`, tagging the mutation with `stepExecId`, setting `lastMutatedByRunId = runId` [preserved across `syncRunOverlays` so lessons admitted on partition $P$ record `createdByRunId = partitions.get(P)?.lastMutatedByRunId ?? ctx.runId`], incrementing the partition's overlay epoch **at most once per `(runId, partitionId)`** via `newEpoch = overlayAlreadyMutatedInRun ? currentOverlayEpoch : currentOverlayEpoch + 1` unless reset by `resetRunOverlay`, and preserving `baseContractTextAtAcquire` rather than reading from the live base store mid-run) so unmerged contract edits in one active run never pollute concurrent runs executing in parallel across the lane:
    * **Direct-Landing vs. PR-Merged Overlay Lifecycle (`.commitOverlayWhen({ onSignal?: { signal, correlateBy, baseBranch? }, discardOnSignal?: { signal, correlateBy }, maxSealedAgeHours?: number })`):** When a flow exits `'done'` in a PR-opening lane configured with `.commitOverlayWhen({ onSignal: { signal: changeShippedSignal, correlateBy: (sig) => sig.ref, baseBranch: (sig) => sig.baseBranch }, discardOnSignal: ... })`, the runtime transitions the run's overlay to `SEALED_UNMERGED` (`TopologyStore.sealRunOverlay(runId)`). Stacked dependent runs (either starting `QUEUED -> RUNNING` with `dependsOn` or waking via `'prerequisite-exit'`) merge the prerequisite's `SEALED_UNMERGED` overlay via `syncRunOverlays(targetRunId, prereqRunIds)`, which also advances `targetRunId`'s 3-way merge-base text (`baseContractTextAtAcquire`) for each absorbed partition $P$ to the prerequisite's `contractText` ($C_1$) (and preserves `lastMutatedByRunId` for each absorbed partition $P$) so sequential stacked PR merges (`commitRunOverlay(T_1)` then `commitRunOverlay(T_parent)`) merge $C_0 \to C_1 \to C_2$ with zero false conflicts. Meanwhile, unrelated runs branching from `main` continue reading the clean base `TopologyStore` until `changeShippedSignal` fires. When `onSignal` fires, `@paraharness/core` resolves `correlateBy(sig)` (`itemKey`) to the latest `'done'` `runId` via `LedgerStore.getRunTerminalReceipts([itemKey])`: if the PR merged into an unmerged prerequisite branch (e.g., `baseBranch(sig) === 'fix/#102'`), the runtime resolves `'#102'` to `prereqRunId` and invokes `TopologyStore.syncRunOverlays(prereqRunId, [runId])` to fold `runId`'s overlay into `prereqRunId`'s `SEALED_UNMERGED` overlay so both commit to the base store only when `fix/#102` merges into `main`; if the PR merged into the primary base branch (`baseBranch(sig) === 'main'`, or when `baseBranch` is omitted), the runtime invokes `const { committedRunIds, updatedEpochs } = await TopologyStore.commitRunOverlay(runId)`. `commitRunOverlay(runId)` atomically commits `runId`'s overlay and any **ancestor/prerequisite** `SEALED_UNMERGED` overlays absorbed via `syncRunOverlays` (never unmerged dependent child overlays that merely synced from `runId`, unless a stacked PR was explicitly merged into `runId`'s branch), allocating `base.epoch = currentBase.epoch + 1` monotonically at commit time, performing a 3-way text merge on `contractText` against `baseContractTextAtAcquire` (falling back to section concatenation only if genuinely concurrent independent runs modified the same lines), and calling `LessonStore.syncCreationEpochsForRuns(committedRunIds, updatedEpochs)` to update `LessonRecord.epochAtCreation = base.epoch` for any lessons created by `committedRunIds` on the updated partitions. (For direct-landing flows without an `onSignal` gate, `commitRunOverlay(runId)` executes immediately on flow exit `'done'`.) Whenever a step aborts/replaces (`git.snapshotAndReset()`) or retries on a lane step retry, `TopologyStore.resetRunOverlay(runId, { scope: 'step', stepExecId })` resets only uncommitted topology overlay mutations tagged with `stepExecId` from the failed/aborted step itself (preserving overlay mutations from earlier `COMPLETED` steps), whereas a full worktree rewind (`git.resetWorktree()`) invokes `TopologyStore.resetRunOverlay(runId, { scope: 'run' })` to reset all uncommitted in-run overlay mutations back to `runId`'s synced prerequisite/run-start base. If a run exits in a failure state, triggers `discardOnSignal` (e.g., PR closed without merging), or exceeds `maxSealedAgeHours` (default `168`), its overlay is discarded via `discardRunOverlay(runId)`.
    * **Turn-0 & Delta Injection:** When an actor binds `.topology(repoTopology)`, the runtime loads `getPartitions(runId)` and injects the live partition graph, contract texts, and epoch numbers into that actor's Turn-0 `[ROLE_AND_SCOPE_CONTEXT]` frame (and injects `[TOPOLOGY_SYNC]` deltas on `resumeFork`), keeping the `P.prefixGroup` wire `system` prompt completely immutable when contracts advance from Epoch $E$ to $E+1$.
* **Graph Queries:**
    * `topology.dependentsOf(partitionId)` returns all strict transitive dependent partition IDs (e.g., `dependentsOf('db') -> ['api', 'web']`).
    * `topology.affectedBy(partitionId)` returns `[partitionId, ...topology.dependentsOf(partitionId)]` (e.g., `affectedBy('db') -> ['db', 'api', 'web']`), ensuring both the target partition itself and all its transitive dependents are paused when a contract violation targets `partitionId`.

## 3.4 Contextual Knowledge (`P.rules`, `P.skill`, `P.lessons`)

### 3.4.1 Rules (`P.rules` & `P.scopedRule`)

Compiles to `RulesNode` (`type: 'harness:rules'`) and `ScopedRuleNode` (`type: 'harness:scoped-rule'`), consuming inline rule objects, `SourceASTNode` descriptors (`GlobalRuleSchema`, `ScopedRuleSchema`), or fluent `P.scopedRule(idOrSource)` builders.

* **`.global(...MaybeSource<GlobalRule | GlobalRule[]>[])`:** Resolved at session start via `RuntimeExecutorRegistry.sources` and pinned in the static system prompt prefix (or `P.prefixGroup`).
* **`.scoped(...MaybeSource<ScopedRule | ScopedRule[]>[])` & `P.scopedRule(idOrSource)`:** Constructed via `P.scopedRule(id).when({ partitions?: string[], effects?: EffectMatcherASTNode }).directive(maybeSourceString).enforceBeforeStop(...CheckASTNode[])` (or by wrapping a frontmatter-loaded `SourceASTNode<ScopedRule>` as `P.scopedRule(md.scopedRule(path)).enforceBeforeStop(...CheckASTNode[])`). The runtime tracks `observedEffects` and `injectedScopedRuleIds` in `agent-frame` (and carries them across `loop-frame` iterations):
    * **Pre-Flight Partition Injection (`when.partitions`):** Injected into the initial Turn-0 `[ROLE_AND_SCOPE_CONTEXT]` frame whenever `when.partitions` is non-empty and intersects the task's `activePartitions` (extracted via `.partitions()`), recording `rule.id` in `injectedScopedRuleIds`.
    * **Deduplicated Reactive Effect Injection (`when.effects`):** Appended directly to `call_i`'s `completedResults` entry at execution time the first time an agent invokes a tool whose `ToolEffect` matches `when.effects` **and** `rule.id` is not already in `injectedScopedRuleIds` (recording `rule.id` in `injectedScopedRuleIds` so rules already injected at Turn 0 via `when.partitions` are never injected a second time, while tasks whose initial `activePartitions` did not include the partition still receive the rule reactively on the first matching tool effect, and reactive notes on `call_1` are preserved in `PendingToolBatch.completedResults` even if `call_2` in the same turn triggers suspension).
    * **Crash-Safe Gate Enforcement:** Executes attached `CheckASTNode` descriptors via `RuntimeExecutorRegistry.checks` during the actor's `beforeStop` gate whenever `rule.id` is in `injectedScopedRuleIds` and at least one scope-mutating effect (`effect.mutatesScope === true`) was recorded in `observedEffects` during the session or enclosing loop.

~~~ts
export const ScopePredicateSchema = z.object({
  partitions: z.array(z.string()).default([]),
  effects: z.custom<EffectMatcherASTNode>().optional(),
});

export type ScopePredicate = z.infer<typeof ScopePredicateSchema>;

export const GlobalRuleSchema = z.object({
  id: z.string(),
  directive: z.string().min(1),
});

export type GlobalRule = z.infer<typeof GlobalRuleSchema>;

export const ScopedRuleSchema = z.object({
  id: z.string(),
  when: ScopePredicateSchema,
  directive: z.string().min(1),
  checks: z.array(z.custom<CheckASTNode>()).default([]),
});

export type ScopedRule = z.infer<typeof ScopedRuleSchema>;
~~~

### 3.4.2 Skills (`P.skill`) & Zero-Invalidation KV-Cache Protocol

Constructed via `P.skill(idOrSource).when({ partitions?: string[], effects?: EffectMatcherASTNode }).description(text).instructions(maybeSourceString).unlocksTools(...ToolASTNode[]).unlocksServices(...ServiceASTNode[]).lease('until-completed-or-fork-exit')`, compiling to `SkillNode` (`type: 'harness:skill'`). Encapsulates on-demand procedural instructions, tools, and services without busting the LLM provider's prompt prefix cache or invalidating cryptographic thinking signatures:

* **Static Wire Tool Registration, Skill Catalog Injection & Lease Gating:** When an `P.agent` is initialized with `.skills(...)`, the catalog of all mounted `(skillId, description)` pairs is injected into the Turn-0 `[ROLE_AND_SCOPE_CONTEXT]` frame (so procedural skills without unlocked tools, such as `sharedProceduralSkills`, are always discoverable), while the built-in `activateSkill({ skillId: z.string() })` and `completeSkill({ skillId: z.string() })` tools along with all tool schemas from `.unlocksTools(...ToolASTNode[])` and `.unlocksServices(...ServiceASTNode[])` (`ServiceASTNode.toolSchemas`) are registered in that actor's wire-level `tools` array from Turn 0 with `[Requires active skill: <id>]` appended to their description (and when `.when(...)` is configured on the skill, the skill is highlighted in `[ROLE_AND_SCOPE_CONTEXT]` or appended to `call_i`'s `completedResults` entry when matching partitions or effects are encountered). The wire `tools` array never mutates mid-session. If an agent invokes a skill-gated tool while the skill is inactive (`!<agentFrame>.activeSkillIds.includes(id)`), the runtime blocks the call pre-flight and returns an `isError: true` tool result instructing the agent to call `activateSkill({ skillId: id })` first.
* **Skill Activation (`activateSkill({ skillId })`), Reference-Counted Services & Step-Boundary / Suspension Quiescing:** Resolves instructions (`SourceValue<string>`), acquires `.unlocksServices(...ServiceASTNode[])` sessions via `RuntimeExecutorRegistry.services[serviceNode.type](serviceNode, { runId: ctx.runId, scopeKey, scopeHandle }, ctx)` for the active `scopeHandle` (where `scopeKey` is `${ctx.runId}:${forkId ?? 'root'}`, uniquely identifying the active isolation scope instance before `local.daemon` sanitizes and hashes it into `${sanitizedPrefix}-${sha256(rawScopeKey).slice(0, 8)}`, and reference-counted by `serviceNode.id` across `activeSkillIds` so a service shared by multiple skills is acquired once and stopped only when the last active skill referencing it completes or quiesces), records `skillId` in `agent-frame.activeSkillIds` and `{ messageId, callId }` in `agent-frame.activeSkillActivations[skillId]` (and on `loop-frame.activeSkillIds` / `loop-frame.activeSkillActivations` when activated by the `.act()` actor; `.evaluate()` actors manage their own ephemeral `agent-frame.activeSkillIds` so evaluator skill usage never leaks into or revokes `.act()` skills), grants an execution lease for the skill's tools, and returns the skill instructions in the `tool_result` frame. Whenever an actor finishes its `.act()` or `.evaluate()` step—including when transitioning from `'act'` to `'evaluate'` inside `P.loop` (preventing `guardedWorker` and `evaluator` from colliding on daemons in the same worktree) or when a speculative branch reaches `COMPLETED`—or whenever an active fork or run enters a suspended, parked, or aborting state (`SuspendedForkRecord`, `PARKED_ON_ESCALATION`, `suspend-and-yield-slot`, `onLimitExceeded`, or `.replaceWith()`), the runtime automatically stops active `ServiceSession` daemons (releasing OS `maxDaemons` slots and ephemeral TCP ports). Upon `resumeFork`, unparking, `spawnTasks` run wakeup, process crash recovery, or when `P.loop` rejects in `'evaluate'` and loops back to `'act'`, the runtime transparently re-acquires all services for skills listed in `activeSkillIds` **before** draining `pauseState.pendingToolBatch.remainingCalls` (so any tool call in `remainingCalls` that interacts with a skill service has a live daemon) and—once the resuming `role: 'tool'` or `role: 'user'` frame has been emitted—appends `[SERVICE_REACQUIRED: <serviceId> restarted on new port(s); in-memory session state reset]` to that trailing `tool` or `user` frame via `ModelDriver.appendToolResultNotes`.
* **Skill Completion (`completeSkill({ skillId })`) & Per-`callId` Cross-Model Tombstone Substitution:** Under `.lease('until-completed-or-fork-exit')`, calling `completeSkill({ skillId })`:
    * Immediately decrements reference counts and stops/unmounts any acquired `ServiceSession` instances with zero remaining active skill references (freeing OS daemon slots and ports), removes `skillId` from `activeSkillIds` (looking up `{ messageId: activateMsgId, callId: activateCallId }` from `activeSkillActivations[skillId]` before deleting the entry), and revokes the active execution lease for the skill's tools.
    * Calls `LedgerStore.markFrameTombstone(runId, activateMsgId, activateCallId, "[Skill '<skillId>' completed and unmounted]")` on the earlier `activateSkill` `WireFrameRecord` (`compactedTombstones[activateCallId]`). Whenever `ModelDriver.prepareFork()` synthesizes new `WireFrameRecord` IDs for a forked or escalated session, the runtime remaps `activeSkillActivations[skillId].messageId` to the newly synthesized frame IDs (matching by `callId`) so subsequent `completeSkill` calls target the forked chain's frame ID.
    * **Same-Model Preservation (Including Same-Model `clone-transcript` Forks):** Throughout the active session, across same-model preserved-session `P.loop` iterations, and across same-model `clone-transcript` forks (`sourceModelId === targetModelId`), `rawWireFrame` is transmitted untouched (`substituteTombstones: false`) so the provider's KV prefix cache remains 100% intact and all subsequent `thinking` / encrypted reasoning / `thoughtSignature` blocks retain valid cryptographic signatures.
    * **Cross-Model Escalation Substitution (`sourceModelId !== targetModelId`):** Whenever `ModelDriver.prepareFork()` synthesizes a message chain for a cross-model escalation (`M_1 != M_2`, where provider KV caches and model-specific thinking signatures do not transfer, `substituteTombstones: true`), it substitutes each entry in `compactedTombstones` in place of the corresponding `callId`'s bulky instruction payload (across Anthropic `tool_result` blocks, OpenAI `function_call_output` items, and Gemini `functionResponse` parts).

### 3.4.3 Lessons (`P.lessons`) & Deduplicated Per-Execution Attribution

Compiles to `LessonsNode<TIn>` (`type: 'harness:lessons'`), backed by any `LessonStoreASTNode` (resolved at runtime via `RuntimeExecutorRegistry.lessons` to a `LessonStore`) and mounted on an actor via `.lessons(lessonsNode, opts?: { readonly recordOutcomes?: boolean })` (default `{ recordOutcomes: true }`; setting `{ recordOutcomes: false }` on an orchestrator such as `coordinator` recalls relevant lessons into `[ROLE_AND_SCOPE_CONTEXT]` for architectural planning without double-counting `'clean_pass'` outcomes alongside child `verifiedWorkerLoop` executions). Because high-leverage preventative lessons (negative constraints such as *"Never use X because of Y"*) are obeyed silently across multi-turn sessions, `@paraharness/core` uses objective 4-state execution evidence (`clean_pass`, `gate_rejected_recovered`, `gate_rejected_unrecovered`, `violated`) rather than worker self-citation:

* **Typed Query Extraction (`.queryFrom(inputSchema, (input) => queryText)`):** Extracts a deterministic search query string from the actor's validated input `TIn` (falling back to `JSON.stringify(input)` if omitted) and passes `{ queryText, partitions: ctx.activePartitions }` to `LessonStore.queryCandidates()` (which populates `LessonRecord.relevanceScore` $R(L, Q) \in [0, 1]$).
* **Contrastive Distillation with Acceptance Buffering & Noise Filtering (`.onLoopRecovery()` & `.onGateRecovery({ minFailedChecks?: number })`):**
    * **Outer Loop Recovery (`.onLoopRecovery()`):** Triggered when Iteration $k$ of an `P.loop` fails evaluation and Iteration $k + n$ ($n \ge 1$) is accepted by `.evaluate()` (and inside `.speculate()`, after `WINNER_COMMITTED` is recorded). The distiller agent receives `{ source: 'loop', rejected: { output, scopeReceipt, deficits }, accepted: { output, scopeReceipt } }`.
    * **In-Session Gate Recovery (`.onGateRecovery()`):** When an `P.agent` fails `beforeStop` checks on completion attempt $a$ (with at least `minFailedChecks`, default 1), the runtime snapshots `rejected = { output, scopeReceipt: await scope.inspect(scopeHandle), failedChecks, deficits }` in `agent-frame.lastGateFailureJson`. When attempt $a + m$ ($m \ge 1$) passes all `beforeStop` checks within the same session, the runtime records the candidate recovery pair `{ source: 'gate', rejected, accepted: { output, scopeReceipt } }` in `bufferedGateRecoveries` and triggers the distiller asynchronously (off the critical execution path) **only after** the enclosing `.evaluate()` step (if inside an `P.loop`) accepts the iteration and (if inside `.speculate()`) `WINNER_COMMITTED` is recorded—ensuring rejected iterations, losing speculative branches, and aborted `'INTERRUPTED'` steps never distill false recovery lessons.
    * **Non-Generalizable Noise Filter (`admit: boolean`) & Active-Overlay `epochAtCreation` Sync:** The distiller agent's structured output conforms to `DistilledLessonCandidate` (`{ admit: boolean, partition?: string, directive?: string }`). When `admit: true`, `epochAtCreation` is recorded from `TopologyStore.getPartitions(ctx.runId)` (the active overlay epoch $E_{\text{now}}$, preventing false in-run epoch decay when `runId` updates a partition contract and distills a lesson in the same run) along with `createdByRunId: (candidate.partition ? partitions.get(candidate.partition)?.lastMutatedByRunId : undefined) ?? ctx.runId` (so a lesson admitted in a stacked dependent run whose partition contract was mutated by an unmerged prerequisite run $T_1$ is attributed to $T_1$'s `lastMutatedByRunId`, and when `TopologyStore.commitRunOverlay(runId)` later commits to the base store, `LessonStore.syncCreationEpochsForRuns(committedRunIds, updatedEpochs)` aligns `epochAtCreation` to the newly committed base epoch). If a `beforeStop` or loop failure was caused by a one-off typo or transient mistake rather than a reusable architectural invariant, the distiller returns `{ admit: false }` and no lesson is written to `LessonStore`.
* **Deduplicated Per-Execution Outcome Attribution (`1 outcome per (stepExecId, lessonId)`), Exhausted-Loop Flush, Aborted-Step Discard & Winner-Only Speculative Flush:**
    * To prevent a multi-iteration `P.loop` on a single pathological task from recording multiple violations for the same lesson and prematurely retiring it, lesson outcomes are accumulated in `ContinuationFrame.accumulatedLessonOutcomes` across the lifetime of the top-level `P.loop` (or standalone `P.agent`) and flushed **once** to `LessonStore.recordOutcomes()` when the step completes with `status: 'COMPLETED'` (or, for a `.fork()` child, immediately after `commitChild` records `status: 'CHILD_COMMITTED'`). When a top-level `P.loop` (or `.fork()` child `P.loop`) exhausts `maxIterations` without passing (outside of a losing `.speculate()` branch or an `'INTERRUPTED'` step aborted via `.replaceWith()`), the runtime flushes `accumulatedLessonOutcomes` (`'violated'` or `'gate_rejected_unrecovered'`) to `LessonStore.recordOutcomes()` once (`lessonsFlushed = true`) before transitioning the step/fork to `FAILED`, while discarding `bufferedGateRecoveries`. Whenever a step terminates with `status: 'INTERRUPTED'` (aborting and promoting via `.replaceWith()`, such as a fast-path `scopeTripwire` or `contractViolation` even if `beforeStop` or Iteration 0 evaluation ran prior to the interrupt), all `accumulatedLessonOutcomes` and `bufferedGateRecoveries` for that aborted step are **discarded**. Inside `.speculate()`, outcomes are buffered per branch in `speculate-frame.bufferedLessonOutcomes`—merging `refineWinnerWhen` outcomes into `winnerBranchIndex` **only if** `refineWinnerWhen` completes `COMPLETED`—and flushed to `LessonStore` only *after* `status: 'WINNER_COMMITTED'` is recorded (setting `lessonsFlushed = true` and discarding losing/aborted branches), governed by the strict 4-state precedence order:

$$\texttt{violated} \succ \texttt{gate\_rejected\_unrecovered} \succ \texttt{gate\_rejected\_recovered} \succ \texttt{clean\_pass}$$

* **Active Evaluator Violation (`'violated'`):** When an `P.loop` is configured with `.distillLessonsInto(lessons)`, the runtime persists `recalledLessons` on `loop-frame` and forwards that exact active lesson list directly into the `.evaluate()` actor's context (without re-querying `LessonStore` against the evaluator's wrapper input schema) and augments the evaluator's wire output schema with `_harnessMeta: { violatedLessonIds: string[] }` (stripped before returning the domain evaluation output). Whenever `_harnessMeta.violatedLessonIds.length > 0`, the runtime forces iteration rejection (even if `acceptWhen(evalOut)` returned `true`), and if a recalled lesson is listed in `violatedLessonIds` on *any* rejected iteration of the loop (or if the loop exhausts `maxIterations` after a violation), that lesson's terminal outcome for the loop execution is `'violated'` (counted once).
* **Friction Without Violation (`'gate_rejected_recovered'` vs. `'gate_rejected_unrecovered'`):** Any injected lesson that never recorded `'violated'` during a session that experienced at least one real `beforeStop` check failure or `P.loop` evaluation rejection records `'gate_rejected_recovered'` if the loop/gate subsequently succeeded, or `'gate_rejected_unrecovered'` if the step exhausted `maxIterations` without passing. (Neutral `[TOPOLOGY_SYNC_REVERIFY]` continuations after a sibling pause never count as a `beforeStop` failure.)
* **Silent Preventative Success (`'clean_pass'`):** Whenever an actor session passes all `beforeStop` checks on its first real completion attempt and (if inside an `P.loop`) is accepted by the evaluator on Iteration 0 with zero violations, all lessons injected into that session (when `recordOutcomes !== false`) record a single `'clean_pass'` outcome.
* **Scoring Formula:** Given query $Q$, active partitions $P$, current partition epoch $E_{\text{now}} = \text{partitions.get}(L.\text{partition})?.\text{epoch} ?? 0$, base creation epoch $E_0$ (where $E_{\text{now}} = E_0 = 0$ when $L.\text{partition}$ is `undefined`), and sliding window $W$ of the last $K$ deduplicated step executions ($c_W$ `clean_pass`, $g_W = g_W^{\text{recovered}} + g_W^{\text{unrecovered}}$ total gate-rejected, $v_W$ `violated`, where $c_W + g_W + v_W = |W| \le K$):

$$\text{Score}(L, Q) = R(L, Q) \cdot (1 + \beta \cdot \mathbb{I}(L.\text{partition} \in P)) \cdot \gamma^{\max(0, E_{\text{now}} - E_0)} \cdot \left(\frac{c_W + 1}{c_W + 2v_W + 0.5g_W + 2}\right)$$

where $\beta$ is `partitionMatchBoost` and $\gamma \in (0, 1]$ is `decayOnPartitionEpochChange`.

* **Retirement & Promotion Signals:**
    * `.retireAfter(($r) => $r.maxViolations(v).orMinCleanPassRate(minRate, { afterInjections: m }))` retires any lesson satisfying the 3-way disjunction:

$$\text{totalViolated} \ge v \;\lor\; \left(N_{\text{eff}} \ge m \land \frac{c_W}{N_{\text{eff}}} < \text{minRate}\right) \;\lor\; \left(|W| \ge m \land \frac{c_W}{|W|} < \text{minRate}\right)$$

where $N_{\text{eff}} = c_W + v_W + g_W^{\text{unrecovered}}$ and $m \ge 1$ (preventing both `0 / 0 = NaN` single-failure eviction when $N_{\text{eff}}$ is small and permanent retirement immunity when $|W| \ge m$ has a high `'gate_rejected_recovered'` share and $c_W = 0$).
    * `.emitSignalWhen(signal, ($t) => $t.minCleanPasses(c).maxViolations(v).cooldownHours(h), (lesson: LessonRecord) => TPayload)` projects a qualifying `LessonRecord` via the pure synchronous payload mapper, persists the emission timestamp via `LessonStore.markSignalEmitted(lesson.id, signal.id, emittedAt)` (`LessonRecord.signalLastEmittedAt[signal.id]`), and emits `signal` so high-leverage empirical lessons can be promoted into permanent `P.rules` or deterministic `P.check` gates.

## 3.5 Capability Policies (`P.policy`), Deterministic Post-Flight Scope Diffing & Turn-Batched Suspended Tool Replay

`P.policy(id)` compiles to a passive `PolicyNode` (`type: 'harness:policy'`) enforcing deterministic sandbox guards, default abort hooks (`.onAbort(abortHook)`), and quantitative tripwires over an `P.agent`. Calling `basePolicy.extend(newId)` on a `PolicyBuilder` returns a derived `PolicyBuilder` whose `PolicyNode` inherits all of the base policy's `.guard(...).onViolation(...)` clauses, tripwires, and `.onAbort()` hook while adding or overriding limits:

* **Chained Two-Phase Effect Guard Clauses (`.guard(...PolicyGuardASTNode[]).onViolation(...)`) & `'deny-with-error'` Precedence:**
    * An `P.policy` may declare multiple chained `.guard(...PolicyGuardASTNode[]).onViolation(...)` clauses. Across all guard clauses evaluated on any tool call $c$, **all `'deny-with-error'` clauses are evaluated in declaration order before any `'raise-interrupt'` clause** (ensuring that a tool call touching both an un-leasable `'deny-with-error'` boundary/spec file and a `'raise-interrupt'` test file is immediately denied in-band rather than raising a futile `leaseRequest`). Each guard executor `ctx.registry.policyGuards[guardNode.type](guardNode, op, ctx)` filters `violatedEffects` down to **only** the specific paths/resources that violated that guard and were not covered by `activeLeases`.
    * **Violation Modes:**
        1. **`.onViolation('raise-interrupt', interrupt, (violation) => intrPayload)`:** Requires a pure synchronous mapper projecting `{ blockedCalls: readonly PendingPreFlightCall[], violatedEffects: readonly ToolEffect[], violationSummary: string }` into `interrupt.schema` so deterministic guard failures always produce a schema-valid interrupt payload without requiring an extra LLM generation turn.
        2. **`.onViolation('deny-with-error', messageMapper?)`:** Blocks the unauthorized tool call(s) in-band and returns an `isError: true` `tool_result` frame instructing the actor to either delegate the operation, raise a contract violation (`contractViolation`), or invoke its voluntary `.escalate(...)` capability tool with an LLM-authored decision brief.
    * **Intra-Turn Execution Order, Per-Call `PendingToolBatch` Persistence & Contiguous `.fork()` Batching:** When an assistant turn emits tool calls `(1..k)`:
        * At the start of every tool-calling turn, the runtime initializes `agent-frame.pauseState = { kind: 'tool-batch', pendingToolBatch }` with `completedResults: []`, `blockedCalls: []`, and `remainingCalls` containing all calls `(1..k)`. Regular tool calls execute sequentially in declaration order, evaluating each call's skill-lease gate and pre-flight guard clauses (against the union of `agent-frame.activeLeases`, `loop-frame.grantedLoopLeases`, and `agent-frame.activeSkillIds`—supporting intra-turn `activateSkill` followed immediately by a tool unlocked by that skill) right before executing that call, and after each call `call_i` finishes (both in normal turns and during `remainingCalls` replay), atomically shifting `call_i` from `remainingCalls` to `completedResults` in `LedgerStore` via `updateContinuationStack`.
        * Whenever an assistant turn mixes preceding regular tool calls `(1..m)`, a contiguous `.fork()` / `resumeFork` batch or standalone `.speculate()` or `spawnTasks` / `addDependencies` call `(m+1..p)`, and trailing tool calls `(p+1..k)`, the parent `agent-frame.pauseState.pendingToolBatch` persists `completedResults` `(1..m)` and trailing `remainingCalls` `(p+1..k)` **before** pushing `'fork-batch-frame'` or `'speculate-frame'` or suspending the run on `spawnTasks` (`suspend-and-yield-slot`). Once the sub-frame pops (or upon run wakeup after `spawnTasks`), the parent drains `remainingCalls` `(p+1..k)` in declaration order before emitting the single complete `role: 'tool'` wire frame covering all `callId`s `(1..k)`.
        * If call $i$'s `ToolASTNode` has `effectTracking: 'declared'`, the runtime invokes `toolDriver.describeEffects(toolNode, args, scopeHandle)`. If it passes all `'deny-with-error'` clauses and violates a `'raise-interrupt'` clause $C$, the runtime stops executing further tools in the turn, awaits `toolDriver.describeEffects` across `(i..k)` (for tools with `effectTracking: 'declared'`) to include in `pauseState.pendingToolBatch.blockedCalls` (and tag with `blockedPreFlight: true` and `adjudicatedClauseIds: [...(call.adjudicatedClauseIds ?? []), C.id]`) **only** those calls in `(i..k)` that pass all `'deny-with-error'` clauses and fail the **exact same** `'raise-interrupt'` clause $C$ triggered by call $i$, records all unfinished calls `(i..k)` in exact declaration order inside `pauseState.pendingToolBatch.remainingCalls`, persists `agent-frame.pauseState = { kind: 'adjudication', pendingToolBatch: { completedResults, blockedCalls, remainingCalls }, pendingAdjudication }`, constructs `violation = { blockedCalls, violatedEffects: blockedCalls.flatMap(c => c.violatedEffects), violationSummary: blockedCalls.map(c => c.violationSummary).join('; ') }` (so mappers inspecting `violation.violatedEffects` receive all paths across all batched pre-flight blocked calls), and raises a single batched `interrupt` via `mapper(violation)`.
        * Similarly, when a voluntary interrupt tool (`.canRaise()` or `.escalate()`) is invoked at call $i$ in a multi-tool turn, the runtime records preceding `completedResults`, sets `activeInterruptCallId = call_i.id`, and stores any subsequent calls `(i+1..k)` in `pauseState.pendingToolBatch.remainingCalls` so `resumeFork` Case A or `.resumeWith()` resolves the entire `(1..k)` turn batch cleanly.
    * **Mandatory Post-Flight Check & `try/catch` Scope-Diff Rollback for Code-Executing / Subprocess Tools (Requires `CheckpointableScope`):** Any tool that executes arbitrary code or subprocesses inside the workspace (such as `local.command.asTool()` or `local.streamCheck.asTool()`, including `verifySuite.asTool()`) produces a `ToolASTNode` with `effectTracking: 'subprocess-post-flight'` (and omits `describeEffects` on its `ToolDriver`). If an actor mounts any `ToolASTNode` with `effectTracking: 'subprocess-post-flight'` under an active `PolicyGuardASTNode`, the AST compiler statically verifies at build time that the enclosing flow's `IsolationScopeASTNode` declares `capabilityTier: 'checkpointable' | 'branchable'` (`supportsCheckpoints: true`, never duck-typing runtime methods on the scope AST node):
        * Immediately before invoking call $i$, the runtime snapshots the scoped uncommitted state via `const preToolCkpt = await scope.serializeCheckpoint(scopeHandle)` and persists `agent-frame.pauseState.inFlightPreToolCheckpoint = preToolCkpt` in `LedgerStore`.
        * The runtime keeps `agent-frame.pauseState.inFlightPreToolCheckpoint` set in `LedgerStore` throughout `toolDriver.execute(toolNode, args, ctx)`, `scope.diffEffects()`, policy guard evaluation, and (if disallowed or thrown) `scope.restoreCheckpoint(scopeHandle, preToolCkpt)`, clearing `pauseState.inFlightPreToolCheckpoint = undefined` **only** in the `LedgerStore.updateContinuationStack` call that commits the post-tool state (so a process crash at any point during `toolDriver.execute()`, `diffEffects()`, or `restoreCheckpoint()` deterministically rolls back `pauseState.inFlightPreToolCheckpoint` on boot).
        * `toolDriver.execute(toolNode, args, ctx)` is wrapped in a `try/catch` block: if `toolDriver.execute()` throws an exception or is killed by `AbortSignal` (`timeoutMinutes`), the `catch` block unconditionally executes `await scope.restoreCheckpoint(scopeHandle, preToolCkpt)` before clearing `pauseState.inFlightPreToolCheckpoint` so partial mutations from timed-out or crashed subprocesses never leak into the workspace.
        * Immediately after `toolDriver.execute()` completes normally, the runtime computes `const synthesizedEffects = await scope.diffEffects(preToolCkpt, scopeHandle)` and evaluates the policy's guard clauses (`'deny-with-error'` clauses first, then `'raise-interrupt'` clauses) **before** recording the effects in `ctx.recordEffects()`.
        * If all guard clauses return `allowed: true`, the runtime records `ctx.recordEffects(synthesizedEffects)` (triggering any matching reactive `when.effects` scoped rules or skill highlights), shifts `call_i` from `remainingCalls` to `completedResults`, and clears `pauseState.inFlightPreToolCheckpoint = undefined` in `LedgerStore.updateContinuationStack`.
        * If a guard clause returns `allowed: false` (for example, a newly created test file attempting to write to `packages/db/src/index.ts` or an existing `*.test.ts` file during `verifySuite.asTool()`), the runtime calls `await scope.restoreCheckpoint(scopeHandle, preToolCkpt)` to roll back the unauthorized delta (never recording the rolled-back effects in `observedEffects`). If the violated clause uses `'deny-with-error'`, it shifts `call_i` from `remainingCalls` to `completedResults` with the rollback error, clears `pauseState.inFlightPreToolCheckpoint = undefined`, and continues; if it uses `'raise-interrupt'`, it shifts `{ callId: call_i.id, content: "[Post-Flight Policy Violation — Workspace Rolled Back: ${violationSummary}]", isError: true }` into `pauseState.pendingToolBatch.completedResults`, sets `activeInterruptCallId = call_i.id`, keeps any remaining calls `(i+1..k)` in `pauseState.pendingToolBatch.remainingCalls`, clears `pauseState.inFlightPreToolCheckpoint = undefined` in `LedgerStore.updateContinuationStack`, and raises `interrupt` via `mapper(violation)` (never re-executing the rolled-back subprocess call on `.resumeWith()`).
    * **Declaration-Ordered `remainingCalls` Drain on `.resumeWith(feedback)` & Nested `.adjudicateWith()` Scope:** When an interrupt raised by a pre-flight guard, post-flight rollback, or voluntary interrupt tool is adjudicated via `.onInterrupt()` and resumes via `.resumeWith(feedback)`:
        1. If `.elevateLeaseWhen()` granted a `LeaseDelta`, the runtime adds the lease to both the **outer interrupted actor's** `agent-frame.activeLeases` and any enclosing `loop-frame.grantedLoopLeases` (persisted via the serialized per-step `updateContinuationStack` queue). When `.onInterrupt()` is nested inside `.adjudicateWith()` (e.g., `leaseAdjudicator` raising `normativeEscalation` to `owner`), `$esc.elevateLeaseWhen()` likewise attaches the granted `LeaseDelta` to the **outer interrupted actor's** `agent-frame.activeLeases` and enclosing `loop-frame.grantedLoopLeases`, whereas `$esc.resumeWith()` resumes the adjudicator frame on `pauseState.pendingAdjudication.adjudicatorStack` (deferring the outer actor's `pauseState.pendingToolBatch.remainingCalls` drain until `adjudicatorStack` completes and the outer `.resumeWith()` runs).
        2. When the outer `.resumeWith(feedback)` runs, the runtime persists `adjudicationFeedback: feedback` on `pauseState.pendingToolBatch`. If `activeInterruptCallId` was set by a post-flight rollback, the rolled-back call's error entry in `completedResults` has `\n[Adjudication: ${feedback}]` appended; if `activeInterruptCallId` was set by a voluntary interrupt tool, `{ callId: activeInterruptCallId, content: feedback }` is shifted into `completedResults`; and `activeInterruptCallId` is immediately cleared (`undefined`) so any subsequent interrupt raised while draining `remainingCalls` records its own `activeInterruptCallId`.
        3. The runtime then iterates `pauseState.pendingToolBatch.remainingCalls` **strictly in `(i..k)` declaration order** (never executing a later call before an earlier call), running each call through the **complete per-call execution pipeline** (skill-lease gate, pre-flight `'deny-with-error'` and `'raise-interrupt'` guard clauses with the newly elevated lease, `serializeCheckpoint` / `try/catch` / `diffEffects` post-flight sandboxing for tools with `effectTracking: 'subprocess-post-flight'`, `ctx.recordEffects`, reactive `when.effects` scoped-rule injection, post-call `QuotaTripwire` evaluation, and atomic shift of each completed `call_i` from `remainingCalls` to `completedResults` in `LedgerStore`):
            * Allowed calls execute via `toolDriver.execute(toolNode, args, ctx)` (prepending `[Lease Elevated: ${feedback}]\n\n` on calls that had `blockedPreFlight: true`).
            * If a replayed call still fails a `'raise-interrupt'` clause listed in its `adjudicatedClauseIds` (because the lease was denied or insufficient), the runtime records `[Lease Denied: ${feedback}]` (`isError: true`) in `completedResults` and skips any subsequent calls in `remainingCalls` with `[Skipped: Preceding tool call in turn batch was denied]` (`isError: true`) so dependent calls (such as `verify-suite` after a denied `edit_file`) never run against an unapplied edit.
            * If a replayed call passes all clauses in its `adjudicatedClauseIds` and hits a downstream `'raise-interrupt'` clause not yet in `adjudicatedClauseIds` (or if a subsequent call violates a `'raise-interrupt'` clause or invokes a voluntary interrupt tool), the runtime appends that clause ID to `adjudicatedClauseIds` and suspends at that call with the updated `pauseState.pendingToolBatch` to adjudicate the new interrupt.
            * Once `remainingCalls` is completely drained, the runtime clears `pauseState.pendingToolBatch` (restoring `agent-frame.pauseState = { kind: 'active-turn' }`) and appends a single complete `role: 'tool'` wire frame covering every `callId` `1..k` in the assistant turn.
* **Quantitative Tripwires:**
    * Universal LLM loop tripwires: `.maxTurns(n)`, `.maxCostUsd(n)`, `.maxDurationSeconds(n)` (evaluated against the persisted `turnsTaken`, `costUsd`, and `elapsedDurationMs` counters on `agent-frame`, or against `actTurnsTaken`, `actCostUsd`, and `actElapsedDurationMs` on `loop-frame` when `preserveActorSession(true)` is enabled; `.maxTurns(n)` trips when the agent has completed $n$ turns without passing `beforeStop`, right before invoking turn $n+1$).
    * Domain quota tripwires: `.tripwire(...QuotaTripwireASTNode[])` (e.g., `fs.maxFilesMutated(4)` producing `FsQuotaTripwireNode` from `@paraharness/fs`) evaluated post-flight after each allowed tool execution via `RuntimeExecutorRegistry.quotaTripwires[tripwireNode.type]`.
* **Limit Exceeded State-Machine Sequence (`.onLimitExceeded($l => ...)`):** When any turn, cost, duration, or `QuotaTripwireASTNode` threshold is breached, the runtime executes the following crash-safe sequence in strict order (keeping the interrupted step active as `status: 'RUNNING'` in `LedgerStore` throughout Steps 1–3 via `agent-frame.pauseState = { kind: 'interrupt-flush', interruptId: interrupt.id, flushPromptInjected, flushedInterruptPayloadJson, abortMetaJson }` so a crash at any point before replacement step start recovers deterministically):
    1. **Complete Trailing Wire Frame:** Whenever the current assistant turn contains `tool_use` blocks `(1..k)` whose pairing `role: 'tool'` wire frame has not yet been written to `LedgerStore` (whether in a single-tool turn, on the final call `call_k` where `remainingCalls` is empty, or mid-batch with non-empty `remainingCalls`), the runtime synthesizes `{ callId, content: '[Aborted: Limit Exceeded]', isError: true }` for any unexecuted calls in `remainingCalls`, clears `pauseState.pendingToolBatch`, and appends the complete `role: 'tool'` wire frame to `LedgerStore` so every `tool_use` block `(1..k)` is paired.
    2. **KV-Cache-Preserving Epistemic Flush (`.flushWithInterrupt(interrupt)`):** While the `scopeHandle` is still intact, the runtime sets `agent-frame.pausedAtPhase = 'LIMIT_EXCEEDED_FLUSH'` and `agent-frame.pauseState = { kind: 'interrupt-flush', interruptId: interrupt.id, flushPromptInjected: true }`, attaches the `[LIMIT_EXCEEDED_FLUSH]` directive to the trailing `tool` or `user` frame via `ModelDriver.appendToolResultNotes` (or appends a single `user` frame if the limit was reached after a tool-less `assistant` turn), and invokes a single final turn (`maxTurns: 1`) via `ModelDriver.invokeTurn` with `toolChoice: 'none'` (mapped to `tool_choice: { type: 'none' }` on Anthropic, `tool_choice: 'none'` on OpenAI, and `toolConfig: { functionCallingConfig: { mode: 'NONE' } }` on Gemini), `effort: 'low'`, and `outputSchema: interrupt.schema` while keeping `wirePrefix` (`wireToolSchemas`) intact—preserving a 100% provider KV prefix cache hit for the flush turn while preventing any further tool calls—and persists `flushedInterruptPayloadJson` inside `agent-frame.pauseState`.
    3. **Daemon Quiesce & Scope Abort Hook (`.onAbort(abortHookNode)`):** After the flush turn completes, the runtime first stops (`ServiceSession.stop()`) all active `'scope'`, `'fork'`, and `'skill'` daemons bound to the step so background file watchers cannot race with scope reset, then executes `const abortMeta = await ctx.registry.abortHooks[abortHookNode.type](abortHookNode, { handle: scopeHandle, runId, stepExecId }, ctx)` (or the policy-level `.onAbort(abortHookNode)` if configured), calls `TopologyStore.resetRunOverlay(runId, { scope: 'step', stepExecId })` (rolling back only uncommitted overlay mutations tagged with `stepExecId` while preserving overlay mutations from earlier `COMPLETED` steps), persists `abortMetaJson` in `agent-frame.pauseState`, and attaches `abortMeta` to `stepTelemetry.abortMeta`.
    4. **Interrupt Routing:** Only after `abortHook` (or `restoreCheckpoint`) completes and the enclosing `.onInterrupt(interrupt)` handler resolves (e.g., computing `replacementInput` for `.replaceWith(replacementExecutable, mapper)`) does the runtime atomically persist `recordStepTransition({ stepExecId, status: 'INTERRUPTED', telemetryJson })` (discarding any `accumulatedLessonOutcomes` and `bufferedGateRecoveries` for the aborted step), `updateRunInput(runId, { inputJson: replacementInput })`, and `recordStepStart` for `replacementExecutable` (with `executableId: replacementExecutable.id`).

## 3.6 Humans (`P.human`)

`P.human(id).keepAliveSeconds(n).notify(humanChannelNode)` compiles to a passive `HumanNode` (`type: 'harness:human'`) representing an external human decision authority invoked declaratively via `.ask(human, responseSchema)`, `.escalate()`, or `P.lane.maxCostUsd(limit, human.withName(alias).output(P.BudgetApprovalSchema))`. Calling `human.withName(alias).output(responseSchema)` returns a passive `ScopedHumanTargetNode` (`type: 'harness:scoped-human'`) bound to `responseSchema`. When an `P.human` authority is used for interactive `.ask()`, `.escalate()`, or `.maxCostUsd()` decisions (as opposed to one-way `.onSignal().notify()` alerts), static AST validation verifies `humanChannelNode.interactionMode === 'bidirectional'` (e.g., `SlackApproverNode` from `slack.bot(...)` rather than `SlackNotifierNode` from `slack.webhook(...)`), and its resolved runtime `HumanAdapter` implements `requestDecision` and `cancelDecision`.

## 3.7 Universal Actor (`P.agent`), `.partitions()`, `beforeStop` Gates & Hierarchical Capabilities

`P.agent(id)` is the single LLM actor primitive in `@paraharness/core`, compiling to a passive `AgentNode<TIn, TOut, THandle>` (`readonly type: 'harness:agent'`) member of `StepASTNode<TIn, TOut, THandle>`. Like all `StepASTNode` variants (`AgentNode`, `LoopNode`, `CommandNode`, and domain step nodes in `DomainStepASTNode`), `AgentNode` has zero execution methods and is dispatched at runtime via `executeStepNode` (`switch (node.type)` compile-time narrowing to `executeAgent: NodeExecutor<AgentNode, TIn, TOut, StepExecutionContext<THandle>>`).

### 3.7.1 Prefix Groups, `.partitions()`, Grounding, Instructions, `beforeStop` Gates & Clones

* **`.prefixGroup(group)`:** Joins a compiled `P.prefixGroup` (`PrefixGroupNode`) so actors share a byte-identical wire `system` prompt (and, when `toolsMode: 'union'` is configured, `wireToolSchemasByRoleKey['*']`).
* **`.partitions((input: TIn) => readonly string[])`:** Pure synchronous extractor mapping the actor's validated input `TIn` to `ResolutionContext.activePartitions` (driving scoped rule injection, lesson candidate queries, and sibling partition pause matching).
* **`.topology(topology)`:** Injects live partition contracts and epoch numbers into the Turn-0 `[ROLE_AND_SCOPE_CONTEXT]` user frame (never into the static wire `system` prompt).
* **`.grounding(...MaybeSource<string>[])` & `.instructions(...MaybeSource<string>[])`:** Resolved at session start via `RuntimeExecutorRegistry.sources` and hashed by digest. When `.prefixGroup()` is bound, actor-specific `.instructions()` are placed in the Turn-0 `[ROLE_AND_SCOPE_CONTEXT]` user frame so the top-level wire `system` field stays invariant.
* **`.beforeStop(...CheckASTNode<THandle>[])`:** An assistant turn is a structured-output completion turn if and only if `(!canonical.toolCalls || canonical.toolCalls.length === 0)`. Whenever `.act()` inside an `P.loop` persists a structured-output `assistant` turn (with zero `tool_use` blocks), the runtime immediately updates `loop-frame.preservedActLeafMessageId = leafMessageId` in `LedgerStore` **before** checking the sibling pause barrier or entering `.beforeStop()`. The harness then intercepts completion and executes all attached `CheckASTNode` descriptors via `RuntimeExecutorRegistry.checks`, any `enforceBeforeStopChecks` from triggered scoped rules, `scopeNode.conflictCleanCheck` (whenever `conflictCheckArmed === true` from a prior `commitChild`, `syncChild`, or `syncRoot` that reported `status: 'conflict'`), and—if the agent declares `.onChildInterrupt()`—a built-in open-fork gate verifying that `LedgerStore.getSuspendedForks(runId, { parentStepExecId: ctx.stepExecId })` has zero unresolved `SuspendedForkRecord`s for the current step execution (rejecting completion until all suspended forks are resumed or aborted via `resumeFork`). If any check fails, the deficits are appended to the session as a gate-rejection user turn (capturing `lastGateFailureJson` with `await scope.inspect(scopeHandle)` for `.onGateRecovery()` if bound to `.lessons()`) and the agent continues iterating in-session until all gates pass; once all gates pass, active `'skill'`/`'fork'` `ServiceSession` daemons are quiesced before returning or transitioning to `P.loop.evaluate`.
* **Actor-Level Default Interrupt Handlers (`.onInterrupt(interrupt, $intr => ...)`):**
    * **Scoped Input Parameter (`actorInput: TIn`):** An `P.agent<TIn, TOut, THandle>` may bind default `.onInterrupt()` adjudication and lease-elevation handlers directly on the actor definition. In an actor-level handler, the parameters passed to `.adjudicateWith((actorInput, intrPayload) => ...)`, `.elevateLeaseWhen((actorInput, intrPayload, adjudicatorVerdict) => ...)`, `.resumeWith((actorInput, intrPayload, adjudicatorVerdict) => ...)`, and `.replaceWith((actorInput, intrPayload, stepTelemetry) => ...)` start with `actorInput: TIn` and `intrPayload`. Actor-level interrupt handlers execute automatically unless overridden by a step-level `.onInterrupt()` handler for the same interrupt.
    * **Handler, Canonical `roleKey` & Partition Preservation on `.withPolicy()` and `.withTools()`:** Calling `agent.withPolicy(newPolicy)` or `agent.withTools(...extraTools)` on an `AgentBuilder` returns a derived `AgentBuilder` wrapping a cloned `AgentNode` with a canonical, order-independent `roleKey = "${baseActor.id}+tools:${sortedExtraToolNames.join(',')}"` (sorting mounted extra tool names lexicographically, compiled into `CompiledWirePrefix.wireToolSchemasByRoleKey[roleKey]` and persisted on `agent-frame.roleKey` / `loop-frame.roleKey`) that updates the policy mask or appends `extraTools` to the actor's toolset while preserving `.prefixGroup()`, `.partitions()`, `.topology()`, all actor-level `.onInterrupt()` handlers, existing tools, skills, rules, lessons, and `beforeStop` checks bound on the base agent.

### 3.7.2 Hierarchical Capabilities (`.capabilities($cap => ...)`) & Per-Handle Scope Locks

Capabilities that branch scope handles (`.fork()`, `.speculate()`, and `.mutatePlan()` with `suspend-and-yield-slot`) require the enclosing flow's `IsolationScopeASTNode` to declare `capabilityTier: 'branchable'` (`supportsBranching: true`, verified statically at AST build time without duck-typing runtime methods) and be backed at runtime by a `BranchableScope` driver. To prevent concurrent child forks from racing on a shared `parentHandle` without serializing read-only operations, `@paraharness/core` maintains an asynchronous Read/Write lock per `scopeHandle` (`ScopeLockManager`, owned exclusively by `@paraharness/core` at the port call boundary) and a single serialized async write queue per `stepExecId` for `LedgerStore.updateContinuationStack`:

* **Shared Read Lock (`acquireRead`):** Acquired by `@paraharness/core` around `forkChild`, `inspect`, and parent tool executions whose `ToolASTNode` has `effectTracking: 'declared'` and whose `ToolDriver.describeEffects` returns only non-mutating effects (`effect.mutatesScope !== true`, or `[]`), allowing multiple child forks and speculative branches to clone from `parentHandle` concurrently (while `git.cowWorktree.forkChild` uses an internal per-`parentHandle` async flush mutex to auto-commit any dirty working-tree files on `parentHandle` once before parallel CoW clones proceed, never re-entering `ScopeLockManager.acquireWrite`).
* **Exclusive Write Lock (`acquireWrite`):** Acquired by `@paraharness/core` around operations that mutate or reconcile `parentHandle` (`commitChild`, `syncChild`, `syncRoot`, and parent tools whose `describeEffects` include `mutatesScope: true` or whose `ToolASTNode` has `effectTracking: 'subprocess-post-flight'`). Child forks execute concurrently against their own isolated `childHandle` without holding locks on `parentHandle`.
* **Per-Step Serialized `updateContinuationStack` Queue:** All mutations to the active step's `ContinuationFrame[]` tree (including concurrent child forks updating their entries in `'fork-batch-frame'`, speculative branches updating `'speculate-frame'`, and lease/effect/lesson accumulators) are serialized through a per-`stepExecId` in-memory async mutex before calling `LedgerStore.updateContinuationStack(runId, stepExecId, continuationStack)` so concurrent sibling transitions never overwrite each other.

**Capability 1 — Downward Forking (`.fork(toolName, childExecutable, $f => ...)`):**

* Exposes a tool call validated by `.requestSchema(zod)` and projected to the child's input via `.mapInput((parentInput, toolReq) => childInput)`. Contiguous `.fork()` (or `resumeFork`) tool calls in the same assistant turn are grouped and launched concurrently as a `'fork-batch-frame'` after all preceding regular tool calls `(1..m)` in that turn complete (with `completedResults` `(1..m)` and any trailing calls `(p+1..k)` persisted in the parent `agent-frame.pauseState.pendingToolBatch`).
* **History Mode (`.historyMode('shared-prefix-only' | 'clone-transcript')`, default `'shared-prefix-only'`):**
    * Under `'shared-prefix-only'` (default), the child actor shares the compiled `P.prefixGroup` `systemPromptText` alongside its own role-scoped wire `tools` array (`toolsMode: 'role-scoped'`) and starts at `messages[0]` with its own clean `[ROLE_AND_SCOPE_CONTEXT]` + mapped task prompt—preventing parent transcript noise, parent orchestration tool schemas, or parent mid-session skill tombstones from polluting the child.
    * Under `'clone-transcript'` (which requires `P.prefixGroup.toolsMode('union')` if parent and child have different toolsets), `ModelDriver.prepareFork()` clones `parentChain` up to `forkPointMessageId` (with `substituteTombstones: sourceModelId !== targetModelId`, preserving same-model KV cache hits and thinking signatures) and—in **both** `substituteTombstones === false` and `substituteTombstones === true` branches when `forkPointMessageId` is an `assistant` turn containing `tool_use` blocks `(1..k)`—iterates all `toolCalls` `(1..k)` on `forkPointMessageId` to synthesize a single `tool_result` wire frame pairing every `callId` `1..k` (using `precedingCompletedResults` for `(1..m)`, `childRoleContextFrameText` + `childTaskPromptText` for `forkCallId`, and `"[Dispatched/Deferred in parent turn]"` for all other `callId`s in that turn), persisted in `LedgerStore` so neither Anthropic nor OpenAI rejects the forked transcript with HTTP 400.
* Acquires a shared read lock on `parentHandle` to fork a child scope handle (`scope.forkChild`), records an active `'fork-batch-frame'` entry in the parent's `ContinuationFrame[]` stack (invoking `const conflictLease = scope.getConflictLease?.(childHandle)` after `forkChild`; if `conflictLease` is returned, arming `conflictCheckArmed = true` and automatically attaching `conflictLease` to the child's `agent-frame.activeLeases` and any enclosing `loop-frame.grantedLoopLeases`), and executes `childExecutable` inside `childHandle` while keeping the child's nested `ContinuationFrame[]` stack (`loop-frame` -> `agent-frame` with `preservedActLeafMessageId`) live until `commitChild` succeeds.
* **Idempotent Zero-Pollution Conflict-Bounce Reconciliation:** Upon child completion, the runtime acquires the exclusive write lock on `parentHandle` and invokes `const res = await scope.commitChild(childHandle, parentHandle)`:
    * If `res.status === 'clean'`, the runtime immediately persists `status: 'CHILD_COMMITTED'` with `outputJson` and `committedReceiptJson` on the `'fork-batch-frame'` in `LedgerStore.updateContinuationStack` *before* calling `LessonStore.recordOutcomes()` (so a crash during lesson flushing never re-runs `commitChild` against an already-advanced `parent.HEAD`), then flushes the child's deduplicated lesson outcomes and `bufferedGateRecoveries` once and sets `lessonsFlushed = true` *before* releasing the lock and calling `scope.release(childHandle)` (making crash recovery idempotent and preserving `childOutput` if the process restarts while a sibling fork in the batch is still running), and finally returns `{ status: 'COMPLETED', output: childOutput, scopeReceipt: res.data }` (recording `toolResultJson` on the fork entry) as the `tool_result` to the parent, discarding all intermediate child turns from the parent's context window.
    * If `res.status === 'conflict'` (because `parentHandle` advanced while the child was running, or because prior conflicts on `childHandle` remain unresolved), `commitChild` leaves `parentHandle` untouched and materializes the 3-way conflict state inside `childHandle`. The runtime releases the write lock on `parentHandle`, increments `conflictRetryCount`, sets `conflictCheckArmed: true` on the `'fork-batch-frame'` entry (and inner `loop-frame`/`agent-frame`), invokes `const conflictLease = scope.getConflictLease?.(childHandle)` and—if `conflictLease` is returned—automatically attaches `conflictLease` to the child's `agent-frame.activeLeases` and any enclosing `loop-frame.grantedLoopLeases`, rolls the child's enclosing `loop-frame` back to `phase: 'act'` at `preservedActLeafMessageId`, appends a `[COMMIT_CONFLICT]` turn (`res.conflictedSummary`) to the child's inner actor session, re-runs the child (including `conflictCleanCheck`, all `beforeStop` checks, and any enclosing `P.loop` evaluator step), and re-attempts `commitChild` (up to 2 conflict-repair retries before failing the fork).

**Capability 2 — Speculative Execution Tournament (`.speculate(toolName, $s => ...)`) with Non-Destructive Contested Escalation Arbitration:**

* Exposes a tool call validated by `.requestSchema(zod)` that executes as a self-contained `'speculate-frame'` boundary on the parent's `ContinuationFrame[]` stack (never interleaved inside a `'fork-batch-frame'`; any preceding `(1..m)` or trailing `(p+1..k)` tool calls in the same assistant turn are persisted in the parent's `agent-frame.pauseState.pendingToolBatch` and drained after the `'speculate-frame'` pops).
* Forks $B$ parallel child scope handles (`scope.forkChild` under shared read locks), records an active `'speculate-frame'` (`phase: 'RACING'`, `conflictRetryCount: 0`, `conflictCheckArmed: false`) in `ContinuationFrame[]`, and executes `.worker(actorOrLoop)` across the $B$ inputs mapped by `.branches(B, (parentInput, toolReq) => [input0, input1, ...])`, buffering per-branch lesson outcomes in `speculate-frame.bufferedLessonOutcomes` (and quiescing active `ServiceSession` daemons as each branch reaches `COMPLETED`, `FAILED`, or `PARKED_ON_ESCALATION`).
* **Escalation & Upward Interrupt Parking Barrier (`PARKED_ON_ESCALATION`):**
    * While executing inside a speculative branch, endogenous interrupt adjudications handled within the branch (such as `guardedWorker` raising `leaseRequest` to the read-only `leaseAdjudicator` LLM) execute immediately in-branch.
    * If any branch attempts to cross an **exogenous human boundary** (invoking `.ask(human, ...)` or `.escalate(...)` to an `P.human` authority, either directly or via a nested adjudicator raising `normativeEscalation`) **or** raises an unhandled upward interrupt (such as `contractViolation` not caught inside the branch), the tournament supervisor **intercepts and parks** that branch (`status: 'PARKED_ON_ESCALATION'`) without paging the human or aborting sibling branches, quiescing any active `ServiceSession` daemons, capturing its partial `scopeReceipt` (`scope.inspect(childHandle)`) and the structured interrupt/escalation payload while keeping its `childHandle` and `ContinuationFrame[]` stack intact in `'speculate-frame'`.
* **Post-Race Resolution & Non-Destructive Contested Escalation Protection:** Once all $B$ branches reach `COMPLETED`, `FAILED`, or `PARKED_ON_ESCALATION`:
    * **Case 1 — Zero Surviving or Parked Branches (`0 COMPLETED`, `0 PARKED_ON_ESCALATION`):** Releases all child handles (discarding all `bufferedLessonOutcomes`) and returns an `isError: true` aggregate branch failure `tool_result` to the parent actor.
    * **Case 2 — Single Non-Failed Branch Parked on Escalation (`0 COMPLETED`, `1 PARKED_ON_ESCALATION`):** If the single surviving branch is parked on an exogenous `P.human` escalation, the runtime—**before** invoking `HumanAdapter.requestDecision`—atomically updates `speculate-frame.phase = 'RACING'`, sets `branches[parkedBranchIndex].status = 'RUNNING'`, and persists `pauseState.pendingAdjudication.humanRequestId` on the unparked branch's inner `agent-frame` via `LedgerStore.updateContinuationStack` (so a crash or rewind while awaiting the human decision recovers or cancels `humanRequestId` deterministically), awaits the human owner's decision, **records the ruling in `humanRulingsHistory`**, resumes execution until the unparked branch reaches `COMPLETED`, `FAILED`, or parks again, and re-enters Post-Race Resolution (Cases 1–4). If the single parked branch is parked on an unhandled upward interrupt (e.g., `contractViolation`), the runtime releases all child handles (discarding `bufferedLessonOutcomes`) and—if the parent declares `.onChildInterrupt(interrupt)`—resolves the `.speculate()` tool call with a normal wire `tool_result` (`{ status: 'ABORTED_ON_CHILD_INTERRUPT', branchIndex, interruptId, payload }`) on the parent's single timeline. (Whenever $\ge 2$ branches are `PARKED_ON_ESCALATION`, even with `0 COMPLETED`, the tournament routes to **Case 4** so `.arbiter()` selects which single branch to unpark first without paging the human multiple times in parallel.)
    * **Case 3 — Uncontested Single Survivor (`1 COMPLETED`, `0 PARKED_ON_ESCALATION`, `humanRulingsHistory.length === 0`, remaining branches `FAILED` on endogenous errors):** Short-circuits `.crossVerifyWith()` and `.arbiter()`. If `.verifyWinnerWith(evaluator, opts)` is configured on `.speculate()`, the runtime runs `evaluator` once on the sole survivor before committing (if `evaluator` rejects the sole survivor, the branch transitions to `FAILED` and re-enters Case 1); otherwise it transitions to `phase: 'COMMITTING'`, commits `soleWinnerHandle` into `parentHandle` via `commitChild` (using the conflict-bounce loop with `speculate-frame.conflictRetryCount` and `conflictCheckArmed` if `parentHandle` advanced), immediately persists `status: 'WINNER_COMMITTED'` with `outputJson` and the post-commit `scopeReceiptJson` in `LedgerStore.updateContinuationStack` *before* calling `LessonStore.recordOutcomes()`, then flushes `bufferedLessonOutcomes` (and any `bufferedGateRecoveries`) for the sole winner once and sets `lessonsFlushed = true`, releases all child handles, and returns `{ status: 'COMPLETED', winnerBranchIndex: soleWinnerBranchIndex, output: soleWinnerOutput, scopeReceipt: res.data, shortCircuited: true }`. (If `humanRulingsHistory.length > 0`—meaning a previously unparked sibling subsequently failed—the tournament **does not short-circuit** and instead enters Case 4 so `.arbiter()` can verify the sole survivor against `humanRulingsHistory` and `failedBranches`.)
    * **Case 4 — Multiple Completed Survivors, Multiple Parked Branches, Contested Escalation, or Post-Ruling Verification ($\ge 2$ `COMPLETED`, OR $\ge 2$ `PARKED_ON_ESCALATION`, OR $\ge 1$ `COMPLETED` alongside $\ge 1$ `PARKED_ON_ESCALATION`, OR `1 COMPLETED` with `humanRulingsHistory.length > 0`):**
        * The tournament **NEVER short-circuits arbitration when a sibling branch is parked on an escalation, when multiple branches are parked, or after a human ruling**, preventing a branch that quietly hacked around a spec/test/contract contradiction from automatically silencing a sibling branch that legitimately flagged the contradiction (and preventing duplicate parallel human pages when multiple branches park).
        * The runtime transitions `'speculate-frame'` to `phase: 'CROSS_VERIFYING'`, inspects all `COMPLETED` and `PARKED_ON_ESCALATION` branches, runs `.crossVerifyWith(crossVerifier)` across the `COMPLETED` candidates, and transitions to `phase: 'ARBITRATING'` (tracking the arbiter's execution in `activeSubStack` and enforcing a built-in `beforeStop` gate on `arbiterAgent` verifying that `winnerBranchIndex` for `'select-winner'` references a `'COMPLETED'` candidate in `candidates` and `parkedBranchIndex` for `'unpark-escalation'` references a `'PARKED_ON_ESCALATION'` candidate in `candidates`) to invoke `.arbiter(arbiterAgent, { resolveDecision: (verdict) => ... })` with input matching `P.SpeculationInputSchema`:

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
    * **`decision: 'select-winner'`:** The arbiter selects one of the `COMPLETED` branches (`winnerBranchIndex`). If `.refineWinnerWhen(pred, refinementExecutable, mapper)` matches the verdict, the runtime transitions `'speculate-frame'` to `phase: 'REFINING_WINNER'`, snapshots `preRefinementCheckpoint` on the winning handle, seeds `activeSubStack` with `grantedLoopLeases`, `observedEffects`, and `injectedScopedRuleIds` from `branches[winnerBranchIndex].continuationStack` (so previously granted test/spec leases and scoped rules remain active during refinement, while tracking `activeSubStack`'s own isolated `accumulatedLessonOutcomes`; exogenous `P.human` escalations during `REFINING_WINNER` execute directly without parking since the winning branch has already been chosen), and runs `refinementExecutable` on the winning handle **while keeping losing candidate worktrees alive** so `git.candidateComparisonTools` (`evalInCandidates`, `diffCandidates`, `readCandidateFile`) remain usable during refinement:
        * If `refinementExecutable` completes `COMPLETED`, the runtime merges `activeSubStack`'s lesson outcomes into `bufferedLessonOutcomes[winnerBranchIndex]` by 4-state precedence, merges `bufferedGateRecoveries` and `grantedLoopLeases` from the pre-refinement winning stack into `activeSubStack`, persists `branches[winnerBranchIndex].outputJson = refinementOutputJson` immediately when transitioning from `REFINING_WINNER` to `COMMITTING`, and promotes `activeSubStack` as the winning branch's `continuationStack` (so any subsequent `commitChild` conflict bounce rolls back the post-refinement session with all leases intact).
        * If `refinementExecutable` fails (exhausts iterations) or raises any unhandled upward interrupt (`contractViolation`), the runtime discards `activeSubStack`'s lesson outcomes, quiesces any active daemons, restores `preRefinementCheckpoint` on the winning handle, and falls back to the verified pre-refinement winner.
        * Once refinement finishes (or immediately if no refinement is needed), the runtime transitions to `phase: 'COMMITTING'` and reconciles the winning handle into `parentHandle` via `commitChild` (using the conflict-bounce loop with `speculate-frame.conflictRetryCount` and `conflictCheckArmed` if `parentHandle` advanced, while keeping losing candidate worktrees alive until `commitChild` succeeds so `candidateComparisonTools` remain valid if a conflict bounce re-runs `activeSubStack`). Immediately upon `commitChild` returning `status: 'clean'`, the runtime persists `status: 'WINNER_COMMITTED'` with the post-commit `scopeReceiptJson` (`res.data`) and `outputJson` in `'speculate-frame'` via `LedgerStore.updateContinuationStack` *before* calling `LessonStore.recordOutcomes()`, then flushes `bufferedLessonOutcomes` (and `bufferedGateRecoveries`) for `winnerBranchIndex` once and sets `lessonsFlushed = true`, releases all losing/parked and winning `childHandle`s, and returns `{ status: 'COMPLETED', winnerBranchIndex, output: finalWinnerOutput, scopeReceipt: res.data, shortCircuited: false }`.
    * **`decision: 'unpark-escalation'` (Non-Destructive Unparking):**
        * If the selected parked branch (`parkedBranchIndex`) was parked on an exogenous `P.human` escalation (e.g., `normativeEscalation`):
            1. The runtime **retains all already-`COMPLETED` sibling branch handles alive in memory/disk** (never discarding a working candidate prematurely in case the human rules in favor of existing behavior or the unparked branch subsequently fails).
            2. *Before* invoking `HumanAdapter.requestDecision`, the runtime atomically updates `speculate-frame.phase = 'RACING'`, sets `branches[parkedBranchIndex].status = 'RUNNING'`, and persists `pauseState.pendingAdjudication.humanRequestId` on the unparked branch's inner `agent-frame` via `LedgerStore.updateContinuationStack`. It then forwards the pending escalation request to the `P.human` authority, records the ruling in `humanRulingsHistory`, re-acquires any quiesced services, and resumes `parkedBranchIndex` until it transitions to `COMPLETED`, `FAILED`, or parks on a subsequent escalation.
            3. The tournament then re-enters **Post-Race Resolution (Cases 1–4)** over the updated branch states (now including the human's ruling in `humanRulingsHistory` and any `failedBranches`).
        * If the selected parked branch was parked on an unhandled upward interrupt (e.g., `contractViolation`), the runtime aborts and releases all tournament branch handles (discarding `bufferedLessonOutcomes`) and—if the parent declares `.onChildInterrupt(interrupt)`—resolves the `.speculate()` tool call with a normal wire `tool_result` (`{ status: 'ABORTED_ON_CHILD_INTERRUPT', branchIndex: parkedBranchIndex, interruptId, payload }`) so the parent coordinator handles the violation on its single timeline.
    * **`decision: 'reject-all'`:** If none of the surviving candidates satisfy the specification or the human owner's ruling in `humanRulingsHistory`, the arbiter returns `decision: 'reject-all'` with `rationale`, releasing all candidate handles (discarding all `bufferedLessonOutcomes`) and returning an `isError: true` tournament rejection result to the parent actor.

**Capability 3 — Dynamic Plan Mutation (`.mutatePlan($m => ...)`) with Linear Stacking Chain & Prerequisite Priority Boost:**

* `.canSpawnTasks(itemSchema, { maxSpawnedPerRun, maxPrerequisiteDepth?: number, enforcePatch, onPrerequisiteSpawned: 'suspend-and-yield-slot', priorityStrategy?: 'inherit-parent-with-boost' | 'normal', resumeWhen?: 'prerequisite-exit' | { signal: Signal<TPayload>; correlateBy: (sig: TPayload) => string } })`: Mounts a `spawnTasks` tool that enqueues new independent work items into the enclosing `P.lane`.
    * **Slot-Livelock Prevention, Linear Stacking Chain & Initial `QUEUED -> RUNNING` Prerequisite Sync:** Same-lane prerequisite spawning always requires `onPrerequisiteSpawned: 'suspend-and-yield-slot'` and enforces `maxPrerequisiteDepth` (default `3`) and DAG acyclicity atomically inside `LedgerStore.mutateLanePlan` so active parent runs never deadlock all lane concurrency slots waiting on unscheduled children. When `resumeWhen: 'prerequisite-exit'` is configured and a `spawnTasks` call enqueues tasks $[T_1, T_2, \dots, T_k]$, the runtime automatically chains their `dependsOn` edges linearly ($T_{\text{prevTip}} \leftarrow T_1 \leftarrow T_2 \leftarrow \dots \leftarrow T_k \leftarrow T_{\text{parent}}$)—prepending the parent run's current tip prerequisite $T_{\text{prevTip}}$ (if the parent run already has `dependsOn` entries from initial input or an earlier `spawnTasks` call in the same run) to $T_1.\text{dependsOn}$ so all prerequisites spawned across single or multiple turns form a single linear chain where $T_2$ stacks onto $T_1$'s `headRef`/overlay and $T_{\text{parent}}$ stacks cleanly onto the single tip $T_k$ (`baseBranch = T_k.branchName`). Whenever **any** `QUEUED` run with `dependsOn.length > 0` (such as $T_1 \dots T_k$ or an external ticket with `dependsOn`) transitions to `RUNNING` for the first time after its prerequisites exit `'done'`, after acquiring a lane concurrency slot and `acquireRoot(runId)`, the runtime immediately loads the prerequisite receipts via `LedgerStore.getRunTerminalReceipts(dependsOn)`, merges their topology overlays via `TopologyStore.syncRunOverlays(runId, prereqRunIds)`, and invokes `scope.syncRoot(rootHandle, prereqReceipts)` before starting Step 0 so $T_1 \dots T_k$ branch directly from their prerequisite's `headRef` and `SEALED_UNMERGED` topology overlay.
    * **Head-of-Line Prerequisite Priority Inheritance (`priorityStrategy: 'inherit-parent-with-boost'`, default):** When an active run spawns a prerequisite task and suspends via `'suspend-and-yield-slot'`, the runtime persists the DAG mutation via `LedgerStore.mutateLanePlan(...)`, resets `agent-frame.syncedToPrerequisiteCheckpoint = undefined`, persists any preceding `completedResults` `(1..m)` and trailing `remainingCalls` `(p+1..k)` in `agent-frame.pauseState = { kind: 'prerequisite-wait', pendingToolBatch }` via `LedgerStore.updateContinuationStack`, quiesces any active `ServiceSession` daemons, snapshots `headScopeCheckpoint = await scope.serializeCheckpoint(rootHandle)` (when `scope` implements `CheckpointableScope`) in `LedgerStore.recordStepTransition({ stepExecId, status: 'SUSPENDED', headScopeCheckpoint, telemetryJson })`, and yields its lane concurrency slot while the spawned prerequisite automatically inherits the parent's effective aged priority plus a prerequisite head-of-line boost so it schedules ahead of unstarted external tracker tickets at the same priority tier.
    * **Wakeup on Prerequisite Completion or Failure:**
        * When all spawned prerequisites exit in a success terminal state (`'done'`) and satisfy `resumeWhen` (defaulting to `'prerequisite-exit'`), the suspended parent run **first re-acquires a lane concurrency slot**. If `agent-frame.syncedToPrerequisiteCheckpoint` is not yet set, whenever `headScopeCheckpoint` was recorded on `'SUSPENDED'`, the runtime first calls `await scope.restoreCheckpoint(parentRootHandle, headScopeCheckpoint)` before invoking `syncRoot` (a 0-file no-op on the normal path when `symDiff` is empty, while rolling back any partial `HEAD` flush or working-tree materialization if a process crash occurred mid-`syncRoot` before `baseRef` or `syncedToPrerequisiteCheckpoint` was updated, ensuring `syncRoot` is 100% replay-idempotent); it then loads the prerequisite runs' terminal `TReceipt`s via `LedgerStore.getRunTerminalReceipts`, merges their topology overlays via `TopologyStore.syncRunOverlays`, invokes `scope.syncRoot(parentRootHandle, prereqReceipts)` (invoking `const conflictLease = scope.getConflictLease?.(parentRootHandle)` after `syncRoot`; if `syncRoot` returns `status: 'conflict'`, arming `conflictCheckArmed = true` and—when `conflictLease` is returned—attaching `conflictLease` to `activeLeases` so the parent or a delegated child fork can resolve the conflict), computes `updatedTopologyContracts` and `updatedGroundingDiffs`, appends `[PREREQUISITE_SYNC]` (or `[PREREQUISITE_SYNC_CONFLICT]` if `status === 'conflict'`, including `updatedTopologyContracts`, `updatedGroundingDiffs`, and `syncRes.data`) directly to `spawnTasksCallId`'s entry in `pauseState.pendingToolBatch.completedResults`, and persists `syncedToPrerequisiteCheckpoint` (along with `conflictCheckArmed`, any conflict write lease in `activeLeases`, and updated `baseScopeCheckpoint` via `LedgerStore.updateContinuationStack(runId, stepExecId, continuationStack, { baseScopeCheckpoint })` and `LedgerStore.recordStepTransition({ stepExecId, status: 'RUNNING', baseScopeCheckpoint, telemetryJson })`) in `LedgerStore` **before** re-acquiring quiesced `ServiceSession` daemons for `activeSkillIds` and draining `pauseState.pendingToolBatch.remainingCalls`. Once `remainingCalls` is drained and the `role: 'tool'` wire frame is emitted, any `[SERVICE_REACQUIRED]` notes are appended to that frame via `ModelDriver.appendToolResultNotes` + `LedgerStore.replaceMessageFrame`, `agent-frame.syncedToPrerequisiteCheckpoint` is cleared (`undefined`) in `LedgerStore` so any subsequent `spawnTasks` or `addDependencies` call in a later turn of the same run executes a full prerequisite sync, and the parent resumes.
        * If any spawned prerequisite exits in a non-success terminal state (`'abandoned'`, `'exhausted'`, `'cancelled'`), the suspended parent run wakes up once it re-acquires a lane concurrency slot, skips `syncRunOverlays` and `syncRoot`, appends `[PREREQUISITE_FAILED: Task <key> exited with '<state>']` (`isError: true`) directly to `spawnTasksCallId`'s entry in `pauseState.pendingToolBatch.completedResults`, persists `syncedToPrerequisiteCheckpoint` and transitions back to `status: 'RUNNING'` in `LedgerStore`, re-acquires quiesced `ServiceSession` daemons for `activeSkillIds` **before** draining `pauseState.pendingToolBatch.remainingCalls`, emits the `role: 'tool'` frame with any `[SERVICE_REACQUIRED]` notes, and clears `agent-frame.syncedToPrerequisiteCheckpoint = undefined` in `LedgerStore` (and if `rewindPendingToStepId` was set while suspended, injects `[PREREQUISITE_FAILED]` into the rewound step's Turn-0 context) so the parent coordinator can replan or escalate rather than hanging indefinitely.
* `.canAddDependencies()`: Mounts an `addDependencies` tool to insert directed edges in the active lane via `LedgerStore.mutateLanePlan(...)` (validated atomically in `LedgerStore` for DAG acyclicity and `maxPrerequisiteDepth`; if adding an uncompleted same-lane prerequisite to the currently `RUNNING` item, triggers the same `suspend-and-yield-slot` + `inherit-parent-with-boost` transition as `spawnTasks`, resetting `agent-frame.syncedToPrerequisiteCheckpoint = undefined` and snapshotting `headScopeCheckpoint = await scope.serializeCheckpoint(rootHandle)` in `LedgerStore.recordStepTransition({ stepExecId, status: 'SUSPENDED', headScopeCheckpoint, telemetryJson })`).
* `.canUpdateTopologyContracts(topology)`: Mounts an `updatePartitionContract` tool that updates the current run's CoW overlay in `TopologyStore` (`TopologyStore.updateContract(ctx.runId, partitionId, newContractText, ctx.stepExecId)`), setting `lastMutatedByRunId = ctx.runId` and incrementing the partition's overlay epoch at most once per `(runId, partitionId)` (`newEpoch = overlayAlreadyMutatedInRun ? currentOverlayEpoch : currentOverlayEpoch + 1`).

**Capability 4 — Exogenous Escalation with Lease Elevation (`.escalate(interrupt, $esc => ...)`):**

* Exposes an escalation tool call to the agent. When invoked, requests a decision from `.to(human)` validated against `.response(zodSchema)`.
* Supports `.elevateLeaseWhen((decision) => boolean, (decision) => LeaseDelta)` to grant the calling agent a capability lease when the human authority approves mutating a protected resource.

**Capability 5 — Upward Child Interrupt Handling via Continuation-Stack Suspension & Native `resumeFork` (`.onChildInterrupt(interrupt, $intr => ...)`):**

LLM wire protocols require every `tool_use` block in an assistant turn to resolve to a `tool_result` block before the parent agent can take its next turn. `@paraharness/core` resolves upward child interrupts on the single parent timeline via Continuation-Stack Suspend-and-Return:

~~~ts
.onChildInterrupt(contractViolation, ($intr) =>
  $intr
    .pauseSiblingForksInPartitions((v) => repoTopology.affectedBy(v.partition))
    .suspendAndReturnToParent(),
)
~~~

* **Turn-Batch Barrier, Child Continuation-Stack Suspension & Deterministic Sibling Pause Classification:**
    * When a downward child fork raises `interrupt` (e.g., `contractViolation` targeting partition `'db'`), the runtime stops any active `ServiceSession` daemons in that fork, increments its `suspensionEpoch` (minting monotonic `suspendedForkId = "${forkId}#${suspensionEpoch}"`), records `raisedByPhase: 'act' | 'evaluate'`, and—if the interrupt was raised by an `.evaluate()` actor (`raisedByPhase === 'evaluate'`, e.g., `evaluator` inside `P.loop.evaluate`)—pops the read-only evaluator's `agent-frame` and rolls the enclosing `loop-frame` phase back to `'act'` at `preservedActLeafMessageId` (so `resumeFork` resumes the write-capable `.act()` worker rather than the read-only evaluator). After stopping active `ServiceSession` daemons and before calling `LedgerStore.recordForkSuspension(...)`, the runtime snapshots `childScopeCheckpoint = await scope.serializeCheckpoint(childHandle)` (when `scope` implements `CheckpointableScope`) and persists it on both `SuspendedForkRecord.childScopeCheckpoint` and `fork-batch-frame.forks[i].childScopeCheckpoint`, then serializes the full `ContinuationFrame[]` stack into `LedgerStore.recordForkSuspension(...)` with `suspensionReason: 'INTERRUPT_RAISED'` and appends the trigger to `pendingPauseTriggers` on `'fork-batch-frame'` in `LedgerStore` so crash recovery mid-turn-batch barrier reconstructs all sibling triggers and pause payloads.
    * The runtime signals all sibling forks in `.pauseSiblingForksInPartitions((v) => repoTopology.affectedBy(v.partition))` (if another sibling fork also raises an upward interrupt during the barrier wait, appending its trigger to `pendingPauseTriggers` and signaling any newly covered sibling forks in `affectedPartitions`) and waits at the parent turn-batch barrier for all in-flight siblings in the batch to settle (after stopping each paused sibling's active `ServiceSession` daemons, snapshotting `childScopeCheckpoint = await scope.serializeCheckpoint(childHandle)` and persisting it on `SuspendedForkRecord.childScopeCheckpoint` and `fork-batch-frame.forks[i].childScopeCheckpoint` before calling `LedgerStore.recordForkSuspension(...)` with `suspensionReason: 'PAUSED_BY_SIBLING_INTERRUPT'` and `triggeredByForkId`, and recording `toolResultJson` on each settled `forks[]` entry) before assembling `pausedSiblingForkIds` and `alreadyCommittedSiblingForks`:
        1. **Sibling Executing an LLM Turn, Tool Call, or Inner Adjudication:** The runtime lets the sibling's current LLM turn, tool call, or inner LLM adjudication (`leaseAdjudicator`) finish; however, if the sibling is blocked waiting on an exogenous `HumanAdapter.requestDecision` (e.g., `owner` escalation at a `PendingToolBatch` boundary), the runtime immediately cancels the pending human request via `HumanAdapter.cancelDecision(runId, requestId)`, synthesizes `{ callId, content: '[Paused by sibling interrupt — pending escalation cancelled; re-evaluate after topology sync]', isError: true }` for the interrupted/blocked call(s) and all remaining calls in `pauseState.pendingToolBatch.remainingCalls`, resets `agent-frame.pauseState = { kind: 'active-turn' }` (clearing `pauseState.pendingToolBatch` and `pauseState.pendingAdjudication`), and appends the completed `role: 'tool'` wire frame to `LedgerStore` so `leafMessageId` points to a valid `role: 'tool'` frame before pausing with `pausedAtPhase: 'TOOL_BOUNDARY'`. If the sibling itself raised an upward interrupt on that turn, it is classified independently as `SUSPENDED_ON_INTERRUPT` (`suspensionReason: 'INTERRUPT_RAISED'`). Otherwise, if its trailing `leafMessageId` is either a `role: 'tool'` frame (after synthesizing `[Paused by sibling interrupt]` (`isError: true`) for any unexecuted sibling-internal tool calls in that turn and emitting the `role: 'tool'` frame) **or** a `role: 'user'` frame (such as a Turn-0 prompt before Turn 1 finished, a `beforeStop` failure turn, `feedbackMapper(evalResult)`, or `[COMMIT_CONFLICT]`), the runtime stops active `ServiceSession` daemons, snapshots `childScopeCheckpoint = await scope.serializeCheckpoint(childHandle)`, and records `pausedAtPhase: 'TOOL_BOUNDARY'` (Case B); if its trailing message is a final structured-output `assistant` turn with zero `tool_use` blocks, the runtime stops active `ServiceSession` daemons, snapshots `childScopeCheckpoint = await scope.serializeCheckpoint(childHandle)`, and records `pausedAtPhase: 'BEFORE_STOP_GATE'` (Case C).
        2. **Sibling Inside `beforeStop` Checks, Inside `P.loop.evaluate` (`evaluator`), or Awaiting/Retrying `commitChild`:** Because the sibling worker already emitted its final structured output `assistant` turn (and immediately recorded `preservedActLeafMessageId = leafMessageId`), its trailing message frame has no `tool_result` block. The runtime aborts the in-flight `beforeStop` check or `evaluator` session, pops the `evaluator` `agent-frame` (if present), stops any active `ServiceSession` daemons, rolls the enclosing `loop-frame` phase back to `'act'` at `preservedActLeafMessageId`, snapshots `childScopeCheckpoint = await scope.serializeCheckpoint(childHandle)`, and persists the `ContinuationFrame[]` stack with `pausedAtPhase: 'BEFORE_STOP_GATE'` (Case C).
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
* **Crash-Safe `syncChild` Rebase, `action: 'abort'`, Multi-ID Wire Aggregation, Wire-Safe Resumption & Enclosing Loop Completion:**
    * **Multi-ID `resumeFork` Wire `tool_result` Aggregation:** When a single `resumeFork` tool call (`callId`) passes `suspendedForkIds.length > 1`, `'fork-batch-frame'.forks` tracks each resumed fork entry with that `callId`. When constructing the parent's `role: 'tool'` wire frame after the batch settles, all `forks[]` entries sharing the same `callId` are aggregated into a **single** `tool_result` block for `callId` (`{ results: ReadonlyArray<ForkResolutionResult> }` when `suspendedForkIds.length > 1`, or the single result object when `suspendedForkIds.length === 1`).
    * **Handling `action: 'abort'`:** For each `suspendedForkId` in `suspendedForkIds` when `action === 'abort'`, the runtime locates/reattaches `childHandle`, stops any active `ServiceSession` daemons, calls `await scope.release(childHandle)`, discards any `accumulatedLessonOutcomes` and `bufferedGateRecoveries` on the suspended stack, calls `await LedgerStore.resolveSuspendedFork(suspendedForkId, 'ABORTED')`, and returns `{ status: 'ABORTED', suspendedForkId }`.
    * **Handling `action: 'resume'`:** Active `resumeFork` executions are tracked inside a `'fork-batch-frame'` (setting `forks[i].suspendedForkId = suspendedForkId`) on the parent's `ContinuationFrame[]` stack. For each `suspendedForkId`, if `syncedToParentCheckpoint` is not yet set on the fork entry, the runtime acquires the exclusive write lock on `parentHandle`, first calls `await scope.restoreCheckpoint(childHandle, childScopeCheckpoint)` whenever `childScopeCheckpoint` is present (a 0-file no-op on the normal path when `symDiff` is empty, while rolling back any partial working-tree materialization if a process crash occurred mid-`syncChild` before `baseRef` or `syncedToParentCheckpoint` was persisted so `syncChild` is 100% replay-idempotent), then runs `const syncRes = await scope.syncChild(parentHandle, childHandle)` to 3-way merge onto the updated `parentHandle` (if `syncRes.status === 'conflict'`, setting `conflictCheckArmed = true`, invoking `const conflictLease = scope.getConflictLease?.(childHandle)`, and—when `conflictLease` is returned—attaching `conflictLease` to the child's `agent-frame.activeLeases` and any enclosing `loop-frame.grantedLoopLeases`), persists both `syncedToParentCheckpoint` and `syncResultJson` (so a process crash between `syncChild` and message injection never re-runs `syncChild` or loses `syncRes` on reboot), and releases the lock. It then computes `updatedTopologyContracts` and `updatedGroundingDiffs` (against `CompiledWirePrefix.groundingSnapshots`) and executes Case A, B, or C (re-acquiring quiesced `ServiceSession` daemons for `activeSkillIds` **before** draining `pauseState.pendingToolBatch.remainingCalls`, and attaching `[SERVICE_REACQUIRED]` notes to the newly emitted/updated trailing `role: 'tool'` or `role: 'user'` frame):
    * **Case A (`suspensionReason === 'INTERRUPT_RAISED'`):** If `record.raisedByPhase !== 'evaluate'` and `record.suspendedAtCallId` is set on the inner `.act()` `agent-frame` (worker raised the interrupt), places `{ resolution: resolutionSummary, updatedTopologyContracts, updatedGroundingDiffs, sync: syncRes.data, conflict: syncRes.status === 'conflict' ? syncRes.conflictedSummary : undefined }` as the `tool_result` of `record.suspendedAtCallId` in `pauseState.pendingToolBatch.completedResults`, clears `activeInterruptCallId = undefined`, immediately sets `resumeFrameInjected = true` and persists `continuationStack` in `LedgerStore`, re-acquires quiesced `ServiceSession` daemons for `activeSkillIds`, drains any `remainingCalls` in `pauseState.pendingToolBatch` through the full per-call execution pipeline to emit the `role: 'tool'` wire frame, and appends any `[SERVICE_REACQUIRED]` notes to that frame. If `record.raisedByPhase === 'evaluate'` (the interrupt was raised by `.evaluate()` `evaluator` and rolled back to `preservedActLeafMessageId`), re-acquires quiesced `ServiceSession` daemons, appends a synthetic `user` frame `[CONTRACT_VIOLATION_RESOLVED]: Original Deficit: ${record.interruptPayloadJson}\nResolution: ${resolutionSummary}\nUpdated Contracts: ${JSON.stringify(updatedTopologyContracts)}\nUpdated Grounding Diffs: ${JSON.stringify(updatedGroundingDiffs)}\nSync: ${JSON.stringify(syncRes.data)}${syncRes.status === 'conflict' ? `\nConflict: ${syncRes.conflictedSummary}` : ''}` (plus any `[SERVICE_REACQUIRED]` notes) after `preservedActLeafMessageId`, and sets `resumeFrameInjected = true`.
    * **Case B (`suspensionReason === 'PAUSED_BY_SIBLING_INTERRUPT'` at `TOOL_BOUNDARY`):** Re-acquires quiesced `ServiceSession` daemons for `activeSkillIds`, invokes `ModelDriver.appendToolResultNotes(trailingFrame, [`[TOPOLOGY_SYNC]: ${resolutionSummary}\nUpdated Contracts: ${JSON.stringify(updatedTopologyContracts)}\nUpdated Grounding Diffs: ${JSON.stringify(updatedGroundingDiffs)}\nSync: ${JSON.stringify(syncRes.data)}${syncRes.status === 'conflict' ? `\nConflict: ${syncRes.conflictedSummary}` : ''}`, ...serviceReacquiredNotes])` in-place on the trailing `role: 'tool'` or `role: 'user'` frame, persists the updated frame via `LedgerStore.replaceMessageFrame(runId, updatedFrame)`, and sets `resumeFrameInjected = true`.
    * **Case C (`suspensionReason === 'PAUSED_BY_SIBLING_INTERRUPT'` at `BEFORE_STOP_GATE`):** Re-acquires quiesced `ServiceSession` daemons for `activeSkillIds` and appends a synthetic `user` frame (`[TOPOLOGY_SYNC_REVERIFY]: Upstream contract updated (${resolutionSummary}). Updated Contracts: ${JSON.stringify(updatedTopologyContracts)}. Updated Grounding Diffs: ${JSON.stringify(updatedGroundingDiffs)}. Sync: ${JSON.stringify(syncRes.data)}${syncRes.status === 'conflict' ? `. Conflict: ${syncRes.conflictedSummary}` : ''}. Verify your implementation against the synced workspace before completing.` plus any `[SERVICE_REACQUIRED]` notes) after `preservedActLeafMessageId` (or `agent-frame.leafMessageId` for standalone agents) with `neutralSyncContinuation: true` and `resumeFrameInjected = true`—preserving strict `assistant -> user -> assistant` alternation and forcing the worker to re-verify before `beforeStop` **without** incrementing `beforeStop` failure counts, **without** triggering `.onGateRecovery()`, and preserving `'clean_pass'` lesson attribution if post-sync verification passes on the first try.
    * **Full Continuation-Stack Execution & Recursive Epoch Resolution Safety:** As the resumed inner `agent-frame` completes and passes `beforeStop`, execution pops up the restored `ContinuationFrame[]` stack—inheriting `loop-frame.grantedLoopLeases` and running any enclosing `loop-frame` (`evaluator` in `verifiedWorkerLoop`) before invoking `commitChild`. Whenever a resumed fork `${forkId}#${epoch}` transitions to **any** terminal or re-suspended outcome—whether `COMPLETED` (after `commitChild`), `SUSPENDED_ON_INTERRUPT` (minting `${forkId}#${epoch + 1}`), `PAUSED_BY_SIBLING_INTERRUPT` (minting `${forkId}#${epoch + 1}` when paused by a sibling in the same `resumeFork` batch), or `FAILED`—the runtime atomically calls `LedgerStore.resolveSuspendedFork("${forkId}#${epoch}", 'RESUMED')` before recording any `${epoch + 1}` `SuspendedForkRecord`, ensuring prior epochs never remain open in `LedgerStore.getSuspendedForks(runId)`.

## 3.8 Iterative Refinement Loops (`P.loop`), Telemetry Aggregation & Loop-Scoped Lease Inheritance

`P.loop(id)` (`LoopBuilder<TIn, TOut, THandle, TActStepId>`) compiles to the passive `LoopNode<TIn, TOut, THandle, TActStepId>` (`readonly type: 'harness:loop'`) member of `StepASTNode<TIn, TOut, THandle>` without any execution methods (dispatched at runtime via `executeStepNode` `switch (node.type)` narrowing to `executeLoop: NodeExecutor<LoopNode<TIn, TOut, THandle>, TIn, TOut, StepExecutionContext<THandle>>`) by coupling an action step with an evaluation step:

* `.input(inSchema).output(outSchema).partitions(mapper).maxIterations(N).preserveActorSession(boolean).distillLessonsInto(lessons)` (where `.maxIterations` defaults to `3`, and `.input`, `.output`, `.partitions`, and `.returnOutputFrom` are automatically inherited from `.act(stepId, actor)` when omitted).
* `.act<TActId extends string>(stepId: TActId, actor, $act => ...)`: Binds the literal `TActId` step identifier (`actStep.stepId: TActStepId`), sets `inputSchema` and `outputSchema` from `actor`, inherits `extractPartitions` from `actor` (unless overridden via `.partitions()`), defaults `returnOutputFromStepId` to `stepId`, and executes `actor`. When `preserveActorSession` is `true`, subsequent iterations resume the actor's existing conversation session with `feedbackMapper(evalResult)`.
* `.evaluate(stepId, evaluatorActor, { mapInput: (loopInput, actOutput, scopeReceipt) => evalInput, acceptWhen: (evalOut) => boolean, feedbackMapper: (evalOut) => string })`: Before invoking `evaluatorActor`, the harness quiesces active `'skill'`/`'fork'` `ServiceSession` daemons from `.act()`, calls `await scope.inspect(scopeHandle)`, persists both `lastActOutputJson` and `lastActScopeReceiptJson` on `'loop-frame'` when transitioning from `phase: 'act'` to `phase: 'evaluate'` (so crash recovery mid-evaluation retains both), and passes the resulting `scopeReceipt` into `mapInput`.
* **Cumulative Loop Telemetry & Cumulative `preserveActorSession` Policy Limits:** `P.loop` persists and aggregates all `ToolEffect` records (`custom` metrics via `ctx.registry.telemetryCollectors[telemetryNode.type](telemetryNode, observedEffects, ctx)`), total `turnsTaken`, `costUsd`, `elapsedDurationMs` (`durationMs`), and `abortMeta` on `loop-frame` and `agent-frame` across all inner `.act()` and `.evaluate()` iterations into the loop step's `UniversalStepTelemetry` (surviving fork suspensions and process restarts), while separately tracking `actTurnsTaken`, `actCostUsd`, and `actElapsedDurationMs` strictly across `.act()` iterations on `loop-frame`. When `preserveActorSession(true)` is enabled, quantitative `P.policy` tripwires bound on the `.act()` actor (`.maxTurns`, `.maxCostUsd`, `.maxDurationSeconds`, `QuotaTripwireASTNode`) evaluate **cumulatively** against `actTurnsTaken`, `actCostUsd`, and `actElapsedDurationMs` on `loop-frame` (never counting `.evaluate()` turns/cost against the `.act()` actor's tripwires).
* **Loop-Scoped Lease, `.act()`-Scoped Skill, Effect & Scoped-Rule Inheritance (`grantedLoopLeases`, `activeSkillIds`, `activeSkillActivations`, `observedEffects`, `injectedScopedRuleIds`):** Any `LeaseDelta` granted to the `.act()` actor during Iteration $k$ (for example, `leaseAdjudicator` unlocking an existing test file), along with the `.act()` actor's `activeSkillIds`, `activeSkillActivations`, `observedEffects`, and `injectedScopedRuleIds`, is recorded on the enclosing `loop-frame` and automatically inherited by Iteration $k+1..N$—even when Iteration $k+1$ re-acquires quiesced services, escalates to a new model via `prepareFork()`, or resumes after a sibling-interrupt rollback.
* **Derived Loop Clones (`.withTools(...MaybeBuilder<ToolASTNode>[])` & `.withPolicy(policy)`):**
    * Calling `loop.withTools(...extraTools)` returns a derived `P.loop` builder clone that clones `loop.actStep.actor` with `extraTools` appended to `actStep.actor.tools`, derives the canonical lexicographically sorted `roleKey = "${baseActor.id}+tools:${sortedExtraToolNames.join(',')}"`, and sets that `roleKey` on both `LoopNode.roleKey` and `LoopNode.actStep.actor.roleKey` (persisted on `loop-frame.roleKey` and `agent-frame.roleKey`) so `CompiledWirePrefix.wireToolSchemasByRoleKey[roleKey]` and `ModelDriver.invokeTurn` resolve the exact extended toolset seamlessly.
    * Calling `loop.withPolicy(newPolicy)` returns a derived `P.loop` builder clone whose inner `.act()` actor applies `newPolicy` (preserving all actor-level `.onInterrupt()` handlers on the `.act()` actor while leaving the `.evaluate()` actor's `readOnlyPolicy` intact).
* **Model Escalation Across Preserved Sessions:** When `preserveActorSession(true)` is enabled on an actor backed by a model pool with `.escalateOnRetry()`, an evaluation rejection (`acceptWhen(evalOut) === false` or `violatedLessonIds.length > 0`) counts as a retry trigger. The runtime records `lastActModelId` on `loop-frame` (and `modelId` on `agent-frame`); if Iteration $k$ executed on model $M_1$ (`lastActModelId`) and Iteration $k+1$ escalates to model $M_2$ ($M_1 \ne M_2$), the runtime passes the session history through `ModelDriver.prepareFork({ historyMode: 'clone-transcript', parentChain, forkPointMessageId: leafMessageId, wirePrefix, roleKey }, { modelId: M_2, substituteTombstones: true })` (omitting `childRoleContextFrameText` on same-actor escalation so `feedbackMapper(evalResult)` never creates consecutive `user` frames), remaps `activeSkillActivations[skillId].messageId` to the newly synthesized frame IDs (matching by `callId`), **persists the synthesized `WireFrameRecord[]` chain in `LedgerStore`**, and updates `leafMessageId` and `lastActModelId = M_2` before invoking Iteration $k+1$ on $M_2$.
* **Continuation-Stack Interrupt Bubbling:** Any `P.interrupt` raised inside `.act()` or `.evaluate()` not caught by an actor-level or step-level `.onInterrupt()` handler pushes the active `loop-frame` onto `continuationStack` and bubbles up transparently to the enclosing `.fork()`, `.speculate()`, or `P.flow` step.
* `.returnOutputFrom(actStepId: TActStepId)`: Statically constrained at compile time to the literal `TActStepId` registered by `.act(stepId, ...)`; projects the accepted action step's output as the loop's output.

## 3.9 Declarative Flows (`P.flow`), Crash Recovery, `scopeReceipt` Projection & Interrupt Edges

`P.flow(id).input(inSchema).scope(isolationScope).telemetry(telemetryCollector)` (`FlowBuilder<TIn, THandle, TStepIds>`) chains sequential `.step()` and conditional `.branch()` nodes (accumulating their literal step IDs into `TStepIds`) and compiles to a passive `FlowNode<TIn, THandle, TStepIds>` (`readonly type: 'harness:flow'`).

* **Reboot Crash Recovery (`getInterruptedStepsOnBoot` + `reattachRoot`/`reattachChild`):** On startup, the runtime queries `LedgerStore.getInterruptedStepsOnBoot()`, which returns all non-terminal runs (`status: 'QUEUED' | 'RUNNING' | 'WAITING' | 'SUSPENDED'`, with `laneId`, `itemKey`, `inputJson`, `dependsOn`, and `executableId`), including runs interrupted mid-step and runs that crashed between steps (during initial `syncRoot`, between Step $i$ completion and Step $i+1$ start, or during `.replaceWith()` `abortHook`). For each active run, the runtime calls `scope.reattachRoot(runId, baseScopeCheckpoint)` (and `scope.reattachChild` for any active `'fork-batch-frame'`, `'speculate-frame'`, or `SuspendedForkRecord` child handles), restores `agent-frame.pauseState.inFlightPreToolCheckpoint` if a step crashed mid-execution of a post-flight-guarded subprocess tool (`toolNode.effectTracking === 'subprocess-post-flight'`), restores the serialized tree-structured `ContinuationFrame[]` stack (including any `pauseState`—such as `pauseState.pendingAdjudication` or `pauseState.pendingToolBatch`—`roleKey`, `modelId`, `conflictCheckArmed`, telemetry counters, and `pausedAtPhase === 'LIMIT_EXCEEDED_FLUSH'`) into `ExecutionContext.resumeContinuationStack` (selecting `executableId` when a step was previously promoted via `.replaceWith()`), re-acquires any quiesced `ServiceSession` daemons for `activeSkillIds` **before** draining `pauseState.pendingToolBatch.remainingCalls`, resumes execution from the exact step boundary, `P.loop` iteration, `speculate-frame` phase, `agent-frame` message chain, and `pauseState.pendingToolBatch`, and—once the resuming `role: 'tool'` or `role: 'user'` frame is emitted—attaches `[SERVICE_REACQUIRED]` notes.
* **Branching (`.branch(branchStepId, ...)`):** `.branch(branchStepId, $b => $b.output(branchOutSchema).when(pred, $sub => ...).otherwise($sub => ...))` compiles to a passive `FlowBranchNode` (`readonly type: 'harness:flow-branch'`) and requires all branches to produce `branchOutSchema`. In `LedgerStore`, `completedStepOutputsJson` and step rewind targets are keyed under the outer `branchStepId` (e.g., `'execute-work'`) so downstream `.inputFrom((item, steps) => steps[branchStepId])` and `.rewindTo(branchStepId)` resolve deterministically regardless of which inner branch executed.
* **Step Input Projection with Live `scopeReceipt`:** `.inputFrom((flowInput, priorStepOutputs, scopeReceipt) => stepInput)` preserves immutable access to `flowInput` alongside all prior step outputs (restored on crash recovery via `LedgerStore.createOrResumeRun().completedStepOutputsJson`) and the latest `TReceipt` from `scope.inspect(scopeHandle)`.
* **Declarative Interrupt Edges (`.onInterrupt(interrupt, $intr => ...)`):**

**Edge Mode 1 — Adjudication & Lease Elevation (with Suspended Pre-Flight Tool Replay):**

~~~ts
$intr
  .adjudicateWith(adjudicatorExecutable, (flowOrActorInput, intrPayload) => adjudicatorInput)
  .onInterrupt(nestedInterrupt, ($esc) =>
    $esc
      .ask(human, humanResponseSchema)
      .elevateLeaseWhen(
        (humanResponse) => humanResponse.approveSpecMutation,
        (humanResponse) => leaseDelta,
      )
      .resumeWith((humanResponse) => feedbackStringToAdjudicator),
  )
  .elevateLeaseWhen(
    (flowOrActorInput, intrPayload, adjudicatorVerdict) => adjudicatorVerdict.approved,
    (flowOrActorInput, intrPayload, adjudicatorVerdict) => leaseDelta,
  )
  .resumeWith((flowOrActorInput, intrPayload, adjudicatorVerdict) => feedbackStringToInterruptedActor)
~~~

When `.onInterrupt(nestedInterrupt, $esc => ...)` is nested inside `.adjudicateWith()`, `$esc.elevateLeaseWhen()` attaches the granted `LeaseDelta` to the **outer interrupted actor's** `agent-frame.activeLeases` and any enclosing `loop-frame.grantedLoopLeases`, whereas `$esc.resumeWith()` resumes the adjudicator frame on `pauseState.pendingAdjudication.adjudicatorStack` (deferring the outer actor's `pauseState.pendingToolBatch.remainingCalls` drain until `adjudicatorStack` completes and the outer `.resumeWith()` runs).

**Edge Mode 2 — Step Replacement / Promotion with Mandatory Daemon Quiesce, Scope Cleanup (`.onAbort`) & Flow Input Promotion:**

~~~ts
$intr
  .onAbort(abortHook) // Optional override; defaults to policy's .onAbort() or scope.restoreCheckpoint(scopeHandle, baseScopeCheckpoint)
  .replaceWith(
    replacementExecutable,
    (flowInput, intrPayload, stepTelemetry) => replacementInput,
  )
~~~

Whenever a step is terminated and replaced via `.replaceWith()`, the runtime keeps the interrupted step active in `LedgerStore` (`agent-frame.pauseState = { kind: 'interrupt-flush', interruptId: interrupt.id, flushedInterruptPayloadJson: JSON.stringify(intrPayload), abortMetaJson }`) while executing daemon quiescing and scope cleanup, and **only after** `abortHook` (or `restoreCheckpoint`) completes and `replacementInput` is computed does the runtime atomically persist `recordStepTransition({ stepExecId, status: 'INTERRUPTED', telemetryJson })` (discarding any `accumulatedLessonOutcomes` and `bufferedGateRecoveries` from the aborted step), `updateRunInput(runId, { inputJson: JSON.stringify(replacementInput) })` (so subsequent `.rewindTo()` signals on the step preserve promoted fields such as `routingTier: 'deep'`), and `recordStepStart` for `replacementExecutable` (with `executableId: replacementExecutable.id`), guaranteeing that `replacementExecutable` never inherits active daemons, uncommitted topology overlays, or dirty workspace mutations left behind by the aborted actor:

1. If `stepTelemetry.abortMeta` was not already populated by `P.policy.onLimitExceeded`, the runtime first stops (`ServiceSession.stop()`) all active `'scope'`, `'fork'`, and `'skill'` daemons bound to the step, calls `TopologyStore.resetRunOverlay(runId, { scope: 'step', stepExecId })` (resetting uncommitted overlay mutations tagged with `stepExecId` from the aborted step while preserving mutations from earlier `COMPLETED` steps), and checks if `.onAbort(abortHook)` is configured on the `$intr` edge (or on the interrupted actor's `P.policy`). If present, it executes `const abortMeta = await ctx.registry.abortHooks[abortHookNode.type](abortHookNode, { handle: scopeHandle, runId, stepExecId }, ctx)`, persists `abortMetaJson` in `agent-frame.pauseState`, and attaches `abortMeta` to `stepTelemetry.abortMeta`.
2. If no `AbortHookASTNode` is configured on either the interrupt edge or the policy, the AST compiler statically verifies `scopeNode.capabilityTier === 'checkpointable' || scopeNode.capabilityTier === 'branchable'` (`supportsCheckpoints: true`) at build time and the runtime automatically executes `await scope.restoreCheckpoint(scopeHandle, stepBaseScopeCheckpoint)` before atomically transitioning the aborted step to `'INTERRUPTED'`, calling `LedgerStore.updateRunInput`, and recording `recordStepStart` for `replacementExecutable`.

## 3.10 Lanes (`P.lane`), Hierarchical Rewind Drain Barrier, Ledger Compaction & Root Harness (`P.harness`)

~~~ts
export const BudgetApprovalSchema = z.object({
  approved: z.boolean(),
  increaseLimitToUsd: z.number().optional(),
});
~~~

* **`P.lane(id)`:** (`LaneBuilder<TIn, TStepIds>`) Compiles to a passive `LaneNode<TIn, TStepIds>` (`readonly type: 'harness:lane'`). Binds `.input(schema)`, `.key(mapper)`, `.tracker(adapter, $t => ...)`, `.flow(flow)` (or `.runs(flow)`, propagating `FlowNode`'s literal `TStepIds` type parameter onto `LaneBuilder<TIn, TStepIds>`), `.concurrency(N)`, `.priority('low' | 'normal' | 'high' | 'critical')`, `.agingMinutes(M)`, `.waitFor(depsMapper, onAbandonedState)`, `.maxCostUsd(limit, human.withName(alias).output(P.BudgetApprovalSchema))` (serializing budget checks per `runId`, persisting `costUsd` and any human-approved `approvedMaxCostUsd` in `LedgerStore.createOrResumeRun`, requiring `increaseLimitToUsd > currentCostUsd` when `approved === true`—defaulting to `2 * currentLimit` if omitted—and transitioning `approved === false` directly to `'cancelled'` via the Hierarchical Drain Barrier without entering `.retry()`), `.retry($r => ...)` (running the Hierarchical Drain Barrier, `scope.restoreCheckpoint(rootHandle, stepBaseScopeCheckpoint)`, and `TopologyStore.resetRunOverlay(runId, { scope: 'step', stepExecId })` before any step retry so only uncommitted overlay mutations tagged with `stepExecId` and workspace changes from the failed step itself are rolled back while preserving earlier `COMPLETED` steps), and `.onSignal(sig, $s => $s.update(mapper).rewindTo(stepId: TStepIds, { onRewind?: MaybeBuilder<ScopeRewindHookASTNode> }))` (statically constraining `stepId` to `TStepIds`).
* **Hierarchical Rewind Drain Barrier & Deferred Rewind While `'SUSPENDED'`:**
    * When `.onSignal(sig, $s => $s.update(mapper).rewindTo(stepId, { onRewind }))` triggers on an active (`'RUNNING'` or `'WAITING'`) run, the runtime first persists the updated `inputJson` (from `mapper(curInput, sigPayload)`) and `rewindPendingToStepId = stepId` in `LedgerStore` via `LedgerStore.updateRunInput(runId, { inputJson, rewindPendingToStepId: stepId })` **before** executing the deterministic 4-step hierarchical drain on `rootHandle`:
        1. Fires the step's `AbortSignal` across all in-flight LLM turns, subprocesses, child `.fork()`s, `.speculate()` branches, and pending `HumanAdapter.requestDecision` calls (and calls `HumanAdapter.cancelDecision(runId, requestId)` if implemented).
        2. Waits for all in-flight child tasks to settle, stops all active `ServiceSession` daemons across the run and its children, and acquires the exclusive write lock on `rootHandle` via `ScopeLockManager`.
        3. Calls `scope.release(childHandle)` on all active and suspended child handles and resolves all open `SuspendedForkRecord`s for `runId` as `'ABORTED'` in `LedgerStore`.
        4. Looks up the target `stepId`'s initial `baseScopeCheckpoint` (`targetStepBaseScopeCheckpoint`). If `onRewindNode` is configured, invokes `await ctx.registry.rewindHooks[onRewindNode.type](onRewindNode, { handle: rootHandle, targetStepBaseScopeCheckpoint }, ctx)` and, if `onRewindNode.resetsRunOverlay` is `true`, also invokes `TopologyStore.resetRunOverlay(runId, { scope: 'run' })`; if `onRewind` is omitted and the flow's scope implements `CheckpointableScope`, defaults to calling `await scope.restoreCheckpoint(rootHandle, targetStepBaseScopeCheckpoint)` and `TopologyStore.resetRunOverlay(runId, { scope: 'run' })`. Finally, restarts `stepId` with a clean `ContinuationFrame[]` stack (clearing `rewindPendingToStepId: null` via `LedgerStore.updateRunInput` when `recordStepStart` is recorded).
    * If `.rewindTo(stepId)` triggers while the run is `'SUSPENDED'` waiting on spawned prerequisite tasks (`onPrerequisiteSpawned: 'suspend-and-yield-slot'`), the runtime immediately persists the updated input from `mapper(curInput, sigPayload)` and sets `rewindPendingToStepId = stepId` in `LedgerStore` via `LedgerStore.updateRunInput(runId, { inputJson, rewindPendingToStepId: stepId })`, deferring `onRewind` and step restart until all spawned prerequisites exit, the run re-acquires a lane concurrency slot, `syncRunOverlays` + `syncRoot` complete (updating `targetStepBaseScopeCheckpoint` to the post-`syncRoot` `baseRef` and injecting any `[PREREQUISITE_FAILED]` notes into the rewound step's Turn-0 context), and Step 3 of the Rewind Drain Barrier executes (releasing any suspended child handles from before `spawnTasks` and resolving all open `SuspendedForkRecord`s for `runId` as `'ABORTED'`) prior to running Step 4 (`onRewind` or default `restoreCheckpoint` + `resetRunOverlay`) and clearing `rewindPendingToStepId: null` on `recordStepStart`.
* **Ledger Compaction (`.compactWhen($c => ...)`):** Configured on `LedgerStoreASTNode` builders (`sqlite.ledger(uri)`, `postgres.ledger(uri)`) via `.compactWhen($c => $c.onSignal(sig, { correlateBy, afterGracePeriodHours }).onTerminalExit(states, { afterGracePeriodHours }).retainFailedRunsForDays(days))` (compiling to a passive `CompactionConfigNode` with `readonly type: 'harness:compaction'`) to prune raw `WireFrameRecord` payloads for a specific terminal `runId` (`LedgerStore.compactRunFrames(runId)`), persisting compaction deadlines in `LedgerStore` so timers survive restarts, never pruning frames of a new active run for the same `itemKey`, and—when a stacked PR merges into an unmerged prerequisite branch (`sig.baseBranch !== 'main'`)—waiting until the root prerequisite lands on `main` before scheduling compaction while retaining run receipts and telemetry.
* **`P.harness(id)`:** Compiles to the root passive `HarnessNode` (`readonly type: 'harness:root'`), composing `.ledger(ledgerStore)`, `.pools(...pools)`, `.streams(...streams)`, `.lanes(...lanes)`, `.onSignal(sig, $s => $s.notify(human, mapper))`, and `.expose(...controlPlaneAdapters)`.

---

# 4. Peer Adapter Package Specifications

Every peer adapter package exports fluent `AstBuilder<TNode>` factories that compile to passive `DomainASTNode` records (with `readonly type: '...'`) and registers its corresponding stateless runtime drivers/executors in `RuntimeExecutorRegistry`.

## 4.1 `@paraharness/claude`, `@paraharness/openai` & `@paraharness/gemini`

~~~ts
export interface ClaudeAccountSeatNode extends BaseAccountSeatASTNode<'claude:account-seat'> {
  readonly id: string;
  readonly configDir?: string;
  readonly apiKey?: string | EnvRef;
}

export interface ClaudeModelNode extends BaseModelASTNode<'claude:model', ClaudeAccountSeatNode> {
  readonly vendor: 'anthropic';
  readonly effort?: 'low' | 'medium' | 'high';
  readonly accountPool?: PoolNode<ClaudeAccountSeatNode>;
}

export interface OpenAiAccountSeatNode extends BaseAccountSeatASTNode<'openai:account-seat'> {
  readonly id: string;
  readonly configDir?: string;
  readonly apiKey?: string | EnvRef;
}

export interface OpenAiModelNode extends BaseModelASTNode<'openai:model', OpenAiAccountSeatNode> {
  readonly vendor: 'openai';
  readonly effort?: 'low' | 'medium' | 'high';
  readonly accountPool?: PoolNode<OpenAiAccountSeatNode>;
}

export interface GeminiAccountSeatNode extends BaseAccountSeatASTNode<'gemini:account-seat'> {
  readonly id: string;
  readonly configDir?: string;
  readonly apiKey?: string | EnvRef;
}

export interface GeminiModelNode extends BaseModelASTNode<'gemini:model', GeminiAccountSeatNode> {
  readonly vendor: 'google';
  readonly effort?: 'low' | 'medium' | 'high';
  readonly accountPool?: PoolNode<GeminiAccountSeatNode>;
}
~~~

* **`@paraharness/claude`:** Exports builders for `ClaudeAccountSeatNode` (`readonly type: 'claude:account-seat'`) and `ClaudeModelNode` (`readonly type: 'claude:model'`), and registers a `ModelDriver` (`RuntimeExecutorRegistry.models['claude:model']`) over the Anthropic `/v1/messages` HTTP protocol for both Claude CLI subscription seats (`claude.cliAccount(id).configDir(path)`, extracting OAuth credentials from `configDir`) and API key fallback seats (`claude.cliAccount(id).apiKey(envRef)`, `claude.model(id, { id }).accountPool(pool)` with run-sticky seat affinity). Uses `CompiledWirePrefix` (`wireToolSchemasByRoleKey[roleKey]`) from `P.prefixGroup` so top-level `system` (and role-scoped or union `tools`) definitions remain byte-identical across invocations. Enforces native JSON-schema structured output (`output_config.format` with `type: 'json_schema'`) whenever `outputSchema` is provided so completion turns and `toolChoice: 'none'` epistemic flush turns never emit synthetic `tool_use` blocks. Supports `toolChoice: 'auto' | 'none'` (preserving `wireToolSchemas` during epistemic flush turns) and generalized `appendToolResultNotes` (appending notes to `targetCallId` or the last `tool_result` block on `role: 'tool'` frames with optional `opts.isError`, or to the text block on plain `role: 'user'` frames in both `rawWireFrame` and `frame.canonical`). Preserves exact Anthropic wire JSON (including `thinking` blocks and cryptographic `signature` fields) in `rawWireFrame`. On `prepareFork`:
    * If `ctx.historyMode === 'shared-prefix-only'`, starts a clean transcript after the cached `CompiledWirePrefix` seeded with `ctx.childRoleContextFrameText`.
    * If `ctx.historyMode === 'clone-transcript'` and `target.substituteTombstones === false` (all same-model forks, `sourceModelId === targetModelId`), replays `rawWireFrame` untouched up to `forkPointMessageId` with `cache_control: { type: 'ephemeral' }`.
    * If `target.substituteTombstones === true` (cross-model retry escalation where `sourceModelId !== targetModelId` and provider KV cache and thinking signatures do not transfer), substitutes per-`callId` `compactedTombstones` strings on completed skill activation frames and projects `CanonicalMessage` frames (omitting `{ type: 'text' }` blocks whenever `canonical.visibleText === ''` and `toolCalls` is non-empty so Anthropic never rejects empty text blocks).
    * In **both** `substituteTombstones === false` and `substituteTombstones === true` branches of `'clone-transcript'`, whenever `forkPointMessageId` is an `assistant` turn with `tool_use` blocks `(1..k)` (`ctx.forkCallId` set), `prepareFork` iterates all `toolCalls` `(1..k)` on `forkPointMessageId` and synthesizes a single `tool_result` wire frame pairing every `callId` `1..k` (using `ctx.precedingCompletedResults` for `(1..m)`, `ctx.childRoleContextFrameText` + `ctx.childTaskPromptText` for `ctx.forkCallId`, and `"[Dispatched/Deferred in parent turn]"` for all other `callId`s in that turn), returning the synthesized `WireFrameRecord[]` chain to be persisted in `LedgerStore`.
* **`@paraharness/openai`:** Exports builders for `OpenAiAccountSeatNode` (`readonly type: 'openai:account-seat'`) and `OpenAiModelNode` (`readonly type: 'openai:model'`), and registers a `ModelDriver` (`RuntimeExecutorRegistry.models['openai:model']`) for OpenAI Responses API and Codex CLI seats (`openai.account(id)`, `openai.model(id, { id })` with run-sticky seat affinity), supporting native JSON-schema structured output (`text.format` with `type: 'json_schema'`), `shared-prefix-only` warm prefix forks, server-side `previous_response_id` branching on `clone-transcript` same-model forks (`substituteTombstones: false`), full-turn `(1..k)` `function_call_output` pairing across both `substituteTombstones === false` and `substituteTombstones === true` branches when `ctx.forkCallId` is set, automatic stripping of `previous_response_id`, server item IDs `rs_...`/`fc_...`/`msg_...`, and `encrypted_content` (replaying `CanonicalMessage` + reasoning summary text) both when `target.substituteTombstones === true` (including same-seat cross-model escalation where `sourceModelId !== targetModelId`) and when failing over across distinct OpenAI seats (`Seat A` to `Seat B`), `toolChoice: 'auto' | 'none'`, generalized `appendToolResultNotes` with `opts?: { isError?: boolean }` across `tool` and `user` frames, and per-`callId` `compactedTombstones` substitution exclusively on cross-model escalations (`sourceModelId !== targetModelId`).
* **`@paraharness/gemini`:** Exports builders for `GeminiAccountSeatNode` (`readonly type: 'gemini:account-seat'`) and `GeminiModelNode` (`readonly type: 'gemini:model'`), and registers a `ModelDriver` (`RuntimeExecutorRegistry.models['gemini:model']`, `vendorId: 'google'`, `vendor: 'google'`) over the Google Gemini `/v1beta/models/{model}:generateContent` HTTP protocol for both Gemini API key seats (`gemini.account(id).apiKey(P.env('GEMINI_API_KEY'))`) and CLI/ADC seats (`gemini.cliAccount(id).configDir(path)` / `.apiKey(P.env(...))`) via `gemini.model(alias, { id, effort?: 'low' | 'medium' | 'high' }).pool(accounts)` (and `.accountPool(accounts)` with run-sticky seat affinity and HTTP `429` `{ status: 429, resetAtMs }` failover):
    * Translates `CompiledWirePrefix` (`systemPromptText` -> `systemInstruction: { parts: [{ text: systemPromptText }] }`, `wireTools` -> `tools: [{ functionDeclarations: wireTools.map(t => ({ name: t.name, description: t.description, parametersJsonSchema: t.inputJsonSchema })) }]`).
    * Preserves `thought: true` and cryptographic `thoughtSignature` fields across turns in `rawWireFrame` (`role: 'model'` `thought` and `functionCall` parts) when `substituteTombstones === false`, and strips model-specific `thought` parts and `thoughtSignature` fields when `substituteTombstones === true` (cross-model fork or escalation).
    * Enforces strict `user` / `model` role alternation, mapping `toolCalls` to `role: 'model'` `functionCall` parts (preserving `id`, `name`, `args`, and `thoughtSignature`) and `toolResults` to `role: 'user'` `functionResponse` parts (`{ functionResponse: { id: callId, name: toolName, response: isError ? { error: content } : { result: content } } }`).
    * Implements `prepareFork` across both `'shared-prefix-only'` and `'clone-transcript'` (synthesizing a single `role: 'user'` turn containing `functionResponse` parts for all `1..k` `toolCalls` on an interrupted `assistant` turn across both `substituteTombstones` branches).
    * Implements `appendToolResultNotes(frame, notes, targetCallId, opts)` (appending to the matching `functionResponse` part or last `functionResponse` part on a `'tool'` frame and updating `response.error` if `opts?.isError === true`, or appending to the `{ text }` part on a `'user'` frame in both `rawWireFrame` and `frame.canonical`).
    * Maps `outputSchema` to `generationConfig.responseMimeType = 'application/json'` and `generationConfig.responseJsonSchema = zodToJsonSchema(outputSchema)`, maps `effort` to `generationConfig.thinkingConfig = { thinkingLevel: effort.toUpperCase(), includeThoughts: true }`, and maps `toolChoice: 'none'` to `toolConfig: { functionCallingConfig: { mode: 'NONE' } }` (and `'auto'` to `'AUTO'`).

## 4.2 `@paraharness/node` (OS Subprocesses, Stream Checks, Daemons & MCP)

Owns all POSIX/OS process execution, standard stream contracts, and dynamic TCP port allocation:

~~~ts
export interface NodeRunnerNode extends BaseRunnerPoolASTNode<'node:runner'> {
  readonly id: string;
  readonly slots: number;
  readonly maxDaemons: number;
}

export interface LocalCommandNode<TIn = unknown, TOut = unknown, THandle = unknown>
  extends BaseDomainStepASTNode<'node:command', TIn, TOut, THandle> {
  readonly runner: NodeRunnerNode;
  readonly argv: readonly string[] | ((input: TIn) => readonly string[]);
  readonly stdinMode: 'closed' | ((input: TIn) => string | Uint8Array);
  readonly env?: Readonly<Record<string, string | EnvRef>>;
  readonly timeoutMinutes?: number;
  readonly unrepeatable?: {
    readonly preCheckCmd: LocalCommandNode<any, boolean, THandle>;
    readonly key: string | ((input: TIn) => string);
  };
}

export interface LocalCommandCheckNode<THandle = unknown>
  extends BaseCheckASTNode<'node:command-check', THandle> {
  readonly command: LocalCommandNode<any, any, THandle>;
}

export interface LocalCommandToolNode<THandle = unknown>
  extends BaseToolASTNode<'node:command-tool', 'subprocess-post-flight', THandle> {
  readonly command: LocalCommandNode<any, any, THandle>;
}

export interface LocalStreamCheckNode<THandle = unknown>
  extends BaseCheckASTNode<'node:stream-check', THandle>,
    BaseDomainStepASTNode<'node:stream-check', unknown, { readonly ok: boolean; readonly deficits: readonly string[] }, THandle> {
  readonly runner: NodeRunnerNode;
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string | EnvRef>>;
  readonly timeoutMinutes?: number;
  readonly circuitBreaker?: {
    readonly pattern: string;
    readonly flags?: string;
    readonly graceLinesAfterMatch: number;
  };
}

export interface LocalStreamCheckToolNode<THandle = unknown>
  extends BaseToolASTNode<'node:stream-check-tool', 'subprocess-post-flight', THandle> {
  readonly check: LocalStreamCheckNode<THandle>;
}

export interface LocalServiceNode extends BaseServiceASTNode<'node:service'> {
  readonly runner: NodeRunnerNode;
  readonly ports: readonly string[];
  readonly startArgv: (ctx: {
    readonly ports: Readonly<Record<string, number>>;
    readonly scopeKey: string;
    readonly worktreePath?: string;
  }) => readonly string[];
  readonly stopArgv?: (ctx: {
    readonly ports: Readonly<Record<string, number>>;
    readonly scopeKey: string;
    readonly worktreePath?: string;
  }) => readonly string[];
  readonly readyWhenStdoutRegex?: { readonly pattern: string; readonly flags?: string };
  readonly interactions: ReadonlyArray<{
    readonly toolName: string;
    readonly description: string;
    readonly inputSchema: z.ZodTypeAny;
    readonly command: (ctx: {
      readonly ports: Readonly<Record<string, number>>;
      readonly scopeKey: string;
      readonly worktreePath?: string;
    }) => readonly string[];
    readonly frameDelimiter: string | { readonly pattern: string; readonly flags?: string };
    readonly idleSettleMs: number;
    readonly timeoutSeconds: number;
  }>;
}

export interface LocalServiceToolNode<THandle = unknown>
  extends BaseToolASTNode<'node:service-tool', 'subprocess-post-flight', THandle> {
  readonly serviceId: string;
}

export interface NodeAllowBinariesNode extends BasePolicyGuardASTNode<'node:allow-binaries'> {
  readonly binaries: readonly string[];
}

export interface NodeDenyNetworkNode extends BasePolicyGuardASTNode<'node:deny-network'> {}

export interface NodeHttpControlPlaneNode extends BaseControlPlaneASTNode<'node:http-control-plane'> {
  readonly port: number;
}

export interface NodeMcpStdioNode extends BaseControlPlaneASTNode<'node:mcp-stdio'> {
  readonly serverName: string;
}

export interface NodeMcpSseNode extends BaseControlPlaneASTNode<'node:mcp-sse'> {
  readonly port: number;
}
~~~

* **`local.runner({ id?: string, slots: number, maxDaemons?: number })`:** Compiles to a passive `NodeRunnerNode` (`readonly type: 'node:runner'`, defaulting `id` to `'default-runner'`), backed at runtime by `RuntimeExecutorRegistry.runners['node:runner']` (`RunnerDriver` with `withSlot` and `withDaemonSlot`). Separates one-shot command execution concurrency (`slots`, acquired by `local.command` and `local.streamCheck`) from long-lived background service concurrency (`maxDaemons`, defaulting to `slots`, acquired by `local.daemon` `ServiceSession`s) so active daemons never starve one-shot test or build commands. Manages process-group/subreaper cleanup (`SIGTERM` followed by `SIGKILL` on orphaned trees) and ephemeral port locks. All `@paraharness/node` subprocesses (`local.command`, `local.streamCheck`, `local.daemon`) execute with `cwd: worktreePath` and isolated `GIT_*` environment variables when `scopeHandle` provides a git worktree path (falling back to the host repository root when `scopeHandle` has no `worktreePath`), resolve `EnvRef` entries via `ctx.resolveEnv`, and abort immediately when `ctx.signal` (`AbortSignal`) fires.
* **`local.command(id)`:** Compiles to a passive `LocalCommandNode` (`readonly type: 'node:command'`, where omitted `.input()` and `.output()` schemas default to `z.unknown()`) participating in `StepASTNode` (dispatched via `RuntimeExecutorRegistry.steps['node:command']`), `CheckASTNode` (via `.asCheck(): AstBuilder<LocalCommandCheckNode>` with `readonly type: 'node:command-check'`), and `ToolASTNode` (via `.asTool(): AstBuilder<LocalCommandToolNode>` with `readonly type: 'node:command-tool'` and `readonly effectTracking: 'subprocess-post-flight'`). Acquires an execution slot via `ctx.getRunner(node.runner).withSlot(...)` and enforces `.stdin('closed')` or `.stdin(bufferMapper)` so interactive CLI prompts never hang runner slots. Supports `.unrepeatable(preCheckCmd, { key })` (executing `preCheckCmd` before the command and skipping execution as a no-op success whenever `preCheckCmd` returns `true`). Non-zero subprocess exit codes throw an execution error (capturing `exitCode`, `stdout`, and `stderr`); on exit code `0`, the executor trims `stdout`, parses it via `JSON.parse` when valid JSON (falling back to the trimmed `stdout` string, or `undefined` when empty), and validates the result against `node.outputSchema.parse(rawOutput)`. Calling `.asTool()` defaults `inputSchema` to `z.object({})` when `argv` is a static `readonly string[]` array (or uses the command's `.input()` schema when `argv` is a mapper function) and sets `effectTracking: 'subprocess-post-flight'` (and omits `ToolDriver.describeEffects`) so any workspace mutations performed by the subprocess are post-flight diffed and policy-checked by `CheckpointableScope.diffEffects()`.
* **`local.streamCheck(id)`:** Compiles to a passive `LocalStreamCheckNode` (`readonly type: 'node:stream-check'`) participating in `CheckASTNode` (dispatched via `RuntimeExecutorRegistry.checks['node:stream-check']`), `StepASTNode`, and `ToolASTNode` (via `.asTool(): AstBuilder<LocalStreamCheckToolNode>` with `readonly type: 'node:stream-check-tool'` and `readonly effectTracking: 'subprocess-post-flight'`). Acquires an execution slot via `ctx.getRunner(node.runner).withSlot(...)`, streams subprocess `stdout` and `stderr` into a combined rolling multi-line buffer, and supports `.circuitBreakWhenStdout(regex, { graceLinesAfterMatch })` (matching across combined `stdout`/`stderr` so test runners writing failure banners to `stderr` or across multiple lines trigger immediately) to abort slow verification suites on the first failure stack trace. Calling `.asTool()` exposes an in-session verification `ToolASTNode` with **`effectTracking: 'subprocess-post-flight'`**—ensuring that if code executed during a test run (such as a newly created test file) attempts to write to protected files (`packages/*/src/index.ts`, `PRODUCT_SPEC.md`, `**/.gitignore`, or existing `*.test.ts` files), `CheckpointableScope.diffEffects()` detects the unauthorized write post-flight, rolls back the working tree delta via `restoreCheckpoint`, and raises the policy's violation interrupt.
* **`local.daemon(id)`:** Compiles to a passive `LocalServiceNode` (`readonly type: 'node:service'`) dispatched via `RuntimeExecutorRegistry.services['node:service']` (`NodeExecutor<LocalServiceNode, { readonly runId: string; readonly scopeKey: string; readonly scopeHandle: any }, ServiceSession<any>, RuntimeDriverContext>`), invoked by the runtime with `(serviceNode, { runId: ctx.runId, scopeKey, scopeHandle }, ctx)` where the input `scopeKey` (`rawScopeKey`) is `${ctx.runId}:${forkId ?? 'root'}` and daemon slots are acquired via `ctx.getRunner(serviceNode.runner).withDaemonSlot(...)`. Declares static `toolSchemas` up front on `LocalServiceNode` for all `.interact()` tools (and emits `LocalServiceToolNode` descriptors with `readonly type: 'node:service-tool'`, `readonly effectTracking: 'subprocess-post-flight'`, and `readonly serviceId: id`, dispatched via `RuntimeExecutorRegistry.tools['node:service-tool']` to `ctx.activeServiceSessions?.get(toolNode.serviceId)?.invokeTool(toolNode.name, args, ctx)`) so wire-level tool definitions remain static across skill activation/deactivation and any filesystem side effects from interactive daemon commands are post-flight diffed via `CheckpointableScope.diffEffects()`. Automatically sanitizes `rawScopeKey` by replacing characters outside `[a-zA-Z0-9_.-]` with `_` **and** appending a deterministic 8-hex-character SHA-256 suffix of the raw unsanitized `scopeKey` (`${sanitizedPrefix}-${sha256(rawScopeKey).slice(0, 8)}`) before passing it to `.start()` or `.stopCommand()` so distinct keys (e.g., `run#1` vs `run_1`) never collide. Manages a stateful background process bound to `.lifecycle('scope' | 'fork' | 'skill')` with dynamic conflict-free port allocation (`.port(name)`), `.start(({ ports, scopeKey, worktreePath }) => argv)`, `.stopCommand(({ ports, scopeKey, worktreePath }) => argv)`, `.readyWhenStdout(regex)` (evaluated over a rolling multi-line window across combined `stdout` and `stderr`, followed by TCP listener readiness verification across all declared `.port()` ports before resolving service acquisition), and framed turn-based interaction tools (`.interact(toolName, { description?, inputSchema?, command, frameDelimiter, idleSettleMs, timeoutSeconds })`, which compiles `frameDelimiter: string | RegExp` into `string | { readonly pattern: string; readonly flags?: string }`, defaults `inputSchema` to `z.object({ input: z.string() })`, defaults `description` to `` `Interact with service via ${toolName}` ``, and spawns `command` inside an OS pseudo-terminal (PTY) with `ECHO` disabled so interactive CLIs like `psql` always emit prompts without echoing input: `ServiceSession.invokeTool` serializes turns per PTY, drains the initial startup banner until `frameDelimiter` matches and output settles for `idleSettleMs`, writes `${args.input}\n`, and resolves the turn output once `frameDelimiter` matches and output settles for `idleSettleMs` within `timeoutSeconds`). Before invoking `.start()`, `local.daemon` executes `.stopCommand` as a best-effort pre-start cleanup to reap any crash-orphaned external containers; on `ServiceSession.stop()`, it executes `.stopCommand` (if configured), sends `SIGTERM` to the process group / subreaper tree with a grace window before escalating to `SIGKILL` (reaping detached child processes such as headless Chromium), and releases allocated ports only after all processes exit.
* **`local.allowBinaries(bins)` & `local.denyNetwork()`:** Compile to passive `NodeAllowBinariesNode` (`readonly type: 'node:allow-binaries'`) and `NodeDenyNetworkNode` (`readonly type: 'node:deny-network'`) members of `PolicyGuardASTNode`.
* **`mcp.server({ port: number })` / `local.mcpStdio(...)` / `local.mcpSse(...)`:** Compile to passive `NodeHttpControlPlaneNode` (`readonly type: 'node:http-control-plane'`), `NodeMcpStdioNode` (`readonly type: 'node:mcp-stdio'`), and `NodeMcpSseNode` (`readonly type: 'node:mcp-sse'`), exposing harness runtime status and signal triggers over Model Context Protocol via `RuntimeExecutorRegistry.controlPlanes`.

## 4.3 `@paraharness/fs` (Filesystem Effects, Partition Maps, Guards & Tools)

Owns all POSIX file path matching, filesystem guards, and file telemetry:

~~~ts
export interface FsReadToolNode<THandle = unknown> extends BaseToolASTNode<'fs:read', 'declared', THandle> {
  readonly runner: NodeRunnerNode;
}
export interface FsEditToolNode<THandle = unknown> extends BaseToolASTNode<'fs:edit', 'declared', THandle> {
  readonly runner: NodeRunnerNode;
}
export interface FsWriteToolNode<THandle = unknown> extends BaseToolASTNode<'fs:write', 'declared', THandle> {
  readonly runner: NodeRunnerNode;
}
export interface FsGlobToolNode<THandle = unknown> extends BaseToolASTNode<'fs:glob', 'declared', THandle> {
  readonly runner: NodeRunnerNode;
}
export interface FsGrepToolNode<THandle = unknown> extends BaseToolASTNode<'fs:grep', 'declared', THandle> {
  readonly runner: NodeRunnerNode;
}

export interface FsTextSourceNode extends BaseSourceASTNode<'fs:text-source', string> {
  readonly path: string;
}

export interface FsGlobSourceNode
  extends BaseSourceASTNode<'fs:glob-source', ReadonlyArray<{ readonly path: string; readonly content: string }>> {
  readonly pattern: string;
}

export interface FsGlobMatcherNode extends BaseEffectMatcherASTNode<'fs:match-globs'> {
  readonly globs: readonly string[];
  readonly mode: 'read' | 'write' | 'any';
}

export interface FsPartitionMapNode<TPartition extends string = string> {
  readonly type: 'fs:partition-map';
  readonly topology: TopologyNode<TPartition>;
  readonly mapping: Readonly<
    Record<TPartition, { readonly globs: readonly string[]; readonly boundaryGlobs: readonly string[] }>
  >;
}

export interface FsBoundaryGuardNode extends BasePolicyGuardASTNode<'fs:boundary-guard'> {
  readonly partitionMap: FsPartitionMapNode<any>;
}

export interface FsWriteGuardNode extends BasePolicyGuardASTNode<'fs:write-guard'> {
  readonly denyGlobs: readonly string[];
  readonly allowGlobs?: readonly string[];
  readonly onlyExistingAtBaseRef?: boolean;
}

export interface FsProtectGuardNode extends BasePolicyGuardASTNode<'fs:protect'> {
  readonly globs: readonly string[];
}

export interface FsReadOnlyGuardNode extends BasePolicyGuardASTNode<'fs:read-only'> {}

export interface FsAllowOnlyGuardNode extends BasePolicyGuardASTNode<'fs:allow-only'> {
  readonly globs: readonly string[];
}

export interface FsRequireReadBeforeWriteGuardNode extends BasePolicyGuardASTNode<'fs:require-read-before-write'> {}

export interface FsScopedWriteGuardNode extends BasePolicyGuardASTNode<'fs:scoped-write'> {
  readonly partitionMap: FsPartitionMapNode<any>;
}

export interface FsSecretLiteralsGuardNode extends BasePolicyGuardASTNode<'fs:secret-literals'> {
  readonly patterns?: readonly string[];
}

export interface FsQuotaTripwireNode extends BaseQuotaTripwireASTNode<'fs:quota-tripwire'> {
  readonly maxFilesMutated: number;
}

export interface FsTelemetryCollectorNode
  extends BaseTelemetryCollectorASTNode<
    'fs:telemetry',
    { readonly filesRead: readonly string[]; readonly filesMutated: readonly string[] }
  > {}

export interface FsRegexCheckNode<THandle = unknown> extends BaseCheckASTNode<'fs:regex-check', THandle> {
  readonly targetGlobs: readonly string[];
  readonly forbidPattern: string;
  readonly forbidFlags?: string;
  readonly violationMessage: string;
}

export interface FsJsonlLessonStoreNode extends BaseLessonStoreASTNode<'fs:jsonl-lesson-store'> {
  readonly definitionsDir: string;
  readonly statsPath: string;
  readonly lockFile: string;
}
~~~

* **`FsToolEffect`:** `{ kind: 'fs:effect', mutatesScope: mode === 'write', attributes: { mode: 'read' | 'write', paths: readonly string[], existingPathsAtBaseRef?: readonly string[], proposedContent?: Readonly<Record<string, string>> } }` (populating `existingPathsAtBaseRef` via `git cat-file -e <baseRef>:<path>` and `proposedContent` with the proposed UTF-8 file text per path when `mode === 'write'` so `fs:secret-literals`, `fs:scoped-write`, `fs:require-read-before-write`, and `LeaseDelta` matcher evaluation have full context).
* **`fs.text(filePath)` & `fs.glob(globPattern)`:** Compile to passive `FsTextSourceNode` (`readonly type: 'fs:text-source'`) and `FsGlobSourceNode` (`readonly type: 'fs:glob-source'`) dispatched via `RuntimeExecutorRegistry.sources` (`NodeExecutor<SourceASTNode, void, { readonly content: any; readonly digest: string }, ResolutionContext>`). Lazily load UTF-8 file text with SHA-256 digest. Harness control-plane definitions (`.instructions()`, `.rules()`, `.skills()`, `.guidelines()`, and initial `.sharedGrounding()` prefix compilation) always resolve paths against the immutable host repository root (`ctx.scopeHandle` omitted), whereas `ResolutionContext.scopeHandle` working-tree resolution is used strictly when computing in-run `updatedGroundingDiffs` for grounding files unlocked by the active actor's policy/leases.
* **`fs.matchGlobs(globs: string[], mode: 'read' | 'write' | 'any' = 'write')`:** Compiles to a passive `FsGlobMatcherNode` (`readonly type: 'fs:match-globs'`) member of `EffectMatcherASTNode` matching `FsToolEffect` paths against glob patterns (defaulting `mode` to `'write'`).
* **`fs.partitionMap(topology, Record<PartitionId, { globs: string[], boundaryGlobs: string[] }>)`:** Compiles to a passive `FsPartitionMapNode` (`readonly type: 'fs:partition-map'`) mapping logical `P.topology` (`TopologyNode`) partitions to physical filesystem globs and public boundary files.
* **`fs.inPartition(partitionMap, partitionId): ScopePredicate`** & **`fs.boundaryGuard(partitionMap)` (`FsBoundaryGuardNode`, `readonly type: 'fs:boundary-guard'`):** Connects `partitionMap` to scoped rules/skills and blocks unapproved edits to `boundaryGlobs` (projecting `violatedEffects` filtered strictly to the violating boundary paths not covered by `activeLeases`).
* **`fs.writeGuard({ denyGlobs: string[], allowGlobs?: string[], onlyExistingAtBaseRef?: boolean })` (`FsWriteGuardNode`, `readonly type: 'fs:write-guard'`), `fs.protect(...)` (`FsProtectGuardNode`, `readonly type: 'fs:protect'`), `fs.readOnly(...)` (`FsReadOnlyGuardNode`, `readonly type: 'fs:read-only'`), `fs.allowOnly(...)` (`FsAllowOnlyGuardNode`, `readonly type: 'fs:allow-only'`), `fs.requireReadBeforeWrite(...)` (`FsRequireReadBeforeWriteGuardNode`, `readonly type: 'fs:require-read-before-write'`), `fs.scopedWrite(...)` (`FsScopedWriteGuardNode`, `readonly type: 'fs:scoped-write'`), `fs.secretLiterals(...)` (`FsSecretLiteralsGuardNode`, `readonly type: 'fs:secret-literals'`) & `fs.allowWriteGlobs(globs: string[]): LeaseDelta`:** Passive `PolicyGuardASTNode` members dispatched via `RuntimeExecutorRegistry.policyGuards` (`NodeExecutor<PolicyGuardASTNode, ...>` receiving `StepExecutionContext<any>` with `observedEffects` and `activePartitions`). `fs.writeGuard` projects `violatedEffects` filtered strictly to the specific paths that matched `denyGlobs` (and not `allowGlobs` or `activeLeases`). `fs.allowWriteGlobs(globs)` produces a serializable `LeaseDelta` (`readonly type: 'harness:lease-delta'`) matching both exact normalized file paths (`globs.includes(path)`) and glob patterns so literal paths containing brackets (e.g., `app/users/[id]/page.test.tsx`) in `req.requestedPaths` work seamlessly. When `onlyExistingAtBaseRef: true` is set, only paths present in `existingPathsAtBaseRef` (files that existed at `handle.baseRef`) are blocked by `denyGlobs`, allowing workers to create new test files freely while intercepting modifications or deletions of existing test files.
* **`fs.maxFilesMutated(count: number)`:** Compiles to a passive `FsQuotaTripwireNode` (`readonly type: 'fs:quota-tripwire'`) member of `QuotaTripwireASTNode` (`RuntimeExecutorRegistry.quotaTripwires`) that trips when distinct mutated file paths exceed `count`.
* **`fs.telemetry()`:** Compiles to a passive `FsTelemetryCollectorNode` (`readonly type: 'fs:telemetry'`) member of `TelemetryCollectorASTNode<{ filesRead: readonly string[], filesMutated: readonly string[] }>` (`RuntimeExecutorRegistry.telemetryCollectors['fs:telemetry']`) collecting accessed file paths from `FsToolEffect` records into `stepTelemetry.custom`.
* **`fs.regexCheck(id, { targetGlobs, forbidPattern, violationMessage })`:** Compiles to a passive `FsRegexCheckNode` (`readonly type: 'fs:regex-check'`) member of `CheckASTNode` (`RuntimeExecutorRegistry.checks['fs:regex-check']`) evaluating `forbidPattern` over files matching `targetGlobs` that were mutated in `observedEffects` (or mutated since `handle.baseRef` on the active worktree), ensuring pre-existing historical files do not trigger false failures.
* **`fs.jsonlLessonStore({ definitionsDir: string, statsPath: string, lockFile: string })`:** Compiles to a passive `FsJsonlLessonStoreNode` (`readonly type: 'fs:jsonl-lesson-store'`) member of `LessonStoreASTNode` (`RuntimeExecutorRegistry.lessons['fs:jsonl-lesson-store']`). Strictly obeys Invariant 5 by resolving all paths against the harness host root, never touching active worktree directories during `admit()` or `recordOutcomes()`. Splits immutable, content-addressed lesson definition files (`<definitionsDir>/<lessonId>.json`, storing `id`, `partition`, `directive`, `epochAtCreation`, `createdByRunId` so git-tracking never suffers adjacent-line EOF `.jsonl` rebase conflicts) from high-frequency, git-ignored telemetry counters (`statsPath`, storing `recentOutcomes`, `totalCleanPasses`, `totalViolated`, post-commit `epochAtCreation` overrides from `syncCreationEpochsForRuns`, and `signalLastEmittedAt` from `markSignalEmitted` so `<definitionsDir>/<lessonId>.json` stays 100% immutable). Synchronizes concurrent reads/writes by combining an in-process async mutex queue with non-blocking kernel advisory locking (`flock(fd, LOCK_EX | LOCK_NB)` with async backoff polling on `lockFile`, never blocking libuv worker threads and automatically releasing on `SIGKILL`), and commits `statsPath` updates via write-to-temp (`${statsPath}.tmp.${pid}.${counter}`) + `fdatasync(2)`/`fsync(2)` + atomic POSIX `rename(2)`.
* **`fs.codingTools(runner?)` & `fs.readOnlyTools(runner?)`:** Return passive `ToolASTNode` tuples (`[FsReadToolNode, FsEditToolNode, FsWriteToolNode, FsGlobToolNode, FsGrepToolNode]` and `[FsReadToolNode, FsGlobToolNode, FsGrepToolNode]` with `readonly type: 'fs:read' | 'fs:edit' | 'fs:write' | 'fs:glob' | 'fs:grep'` and `readonly effectTracking: 'declared'`, defaulting `runner` to `DEFAULT_NODE_RUNNER_AST_NODE` `{ type: 'node:runner', id: 'default-runner', slots: 4, maxDaemons: 4 }` when omitted). Their registered `ToolDriver` implementations in `RuntimeExecutorRegistry.tools` are workspace-jailed file and search tools emitting `FsToolEffect` descriptors with synchronous `describeEffects` (`mutatesScope: false` for read/search tools, `mutatesScope: true` with `existingPathsAtBaseRef` and `proposedContent` for write/edit tools). Before emitting `FsToolEffect.attributes.paths` or touching the filesystem, `fs.codingTools` canonicalizes worktree-relative POSIX paths, resolves any existing target or parent symlinks via `realpath` (verifying the resolved path stays inside `worktreePath`), and denies writes to `**/node_modules/**`.

## 4.4 `@paraharness/git` (CoW Worktree Scope, Crash Reattachment, Deterministic Git-Index Checkpoints & Reconciliation)

Owns all git version control and worktree isolation mechanics:

~~~ts
export interface GitWorktreeHandle {
  readonly worktreePath: string;
  readonly gitDirPath: string;
  readonly baseRef: string;
  readonly baseBranch: string;
  readonly branchName?: string;
  readonly headRef?: string;
  // Maps each conflicted path to its conflict-materialized `${mode}:${sha256}` digest ('MISSING' if absent on disk)
  readonly unresolvedConflictPaths: Readonly<Record<string, string>>;
}

export interface GitScopeReceipt extends Record<string, unknown> {
  readonly headRef: string;
  readonly baseRef: string;
  readonly branchName?: string;
  readonly baseBranch: string;
  readonly diffStat: string;
  readonly mutatedFiles: readonly string[];
}

export interface GitSyncReceipt extends Record<string, unknown> {
  readonly rebasedOntoRef: string;
  readonly baseBranch: string;
  readonly updatedFiles: readonly string[];
}

export interface GitAbortMeta extends Record<string, unknown> {
  readonly abortedSnapshotRef: string;
  readonly resetToRef: string;
}

export interface GitCleanWorkingTreeNode extends BaseCheckASTNode<'git:clean-working-tree', GitWorktreeHandle> {}

export interface GitCowWorktreeNode<
  THandle = GitWorktreeHandle,
  TReceipt extends Record<string, unknown> = GitScopeReceipt,
  TSync extends Record<string, unknown> = GitSyncReceipt,
> extends BaseIsolationScopeASTNode<
    'git:cow-worktree',
    THandle,
    TReceipt,
    TSync,
    'branchable'
  > {
  readonly repo: string;
  readonly dir: string;
  readonly setupCommands: readonly StepASTNode<any, any, THandle>[];
  readonly lockfileGatePath?: string;
  readonly excludeFromCloneGlobs?: readonly string[];
  readonly checkpointPolicy?: {
    readonly partitionMap?: FsPartitionMapNode<any>;
    readonly excludeGlobs?: readonly string[];
    readonly maxUntrackedFileSizeBytes?: number;
  };
  readonly reconcileStrategy?: {
    readonly mode: 'rebase-onto-base' | 'batch-merge-train';
    readonly verifyWith?: CheckASTNode<THandle>;
    readonly maxBatchSize?: number;
  };
  readonly conflictCleanCheck: GitCleanWorkingTreeNode;
}

export interface GitCommitAndPushNode<TIn = unknown>
  extends BaseDomainStepASTNode<'git:commit-and-push', TIn, void, GitWorktreeHandle> {
  readonly branch: (input: TIn) => string;
  readonly message: (input: TIn) => string;
  readonly runner: NodeRunnerNode;
  readonly env?: Readonly<Record<string, string | EnvRef>>;
}

export interface GitMergeQueueNode<TIn = unknown, TOut = unknown>
  extends BaseDomainStepASTNode<'git:merge-queue', TIn, TOut, GitWorktreeHandle> {
  readonly targetBranch: string;
  readonly maxBatchSize: number;
  readonly verifyWith: CheckASTNode<GitWorktreeHandle>;
}

export interface GitSnapshotAndResetNode
  extends BaseAbortHookASTNode<'git:snapshot-and-reset', GitWorktreeHandle, GitAbortMeta> {}

export interface GitKeepWorktreeNode
  extends BaseScopeRewindHookASTNode<'git:keep-worktree', GitWorktreeHandle> {
  readonly resetsRunOverlay: false;
}

export interface GitDiscardBranchNode
  extends BaseScopeRewindHookASTNode<'git:discard-branch', GitWorktreeHandle> {
  readonly resetsRunOverlay: true;
}

export interface GitPatchEquivalenceNode<TCrossReport = Record<string, unknown>>
  extends BaseCrossVerifierASTNode<
    'git:patch-equivalence',
    GitWorktreeHandle,
    GitScopeReceipt,
    TCrossReport
  > {}

export interface GitPublicSurfaceCrossTesterNode<TCrossReport = Record<string, unknown>>
  extends BaseCrossVerifierASTNode<
    'git:public-surface-cross-tester',
    GitWorktreeHandle,
    GitScopeReceipt,
    TCrossReport
  > {
  readonly runner: NodeRunnerNode;
  readonly partitionMap: FsPartitionMapNode<any>;
}

export interface GitRefReaderToolNode<THandle = GitWorktreeHandle>
  extends BaseToolASTNode<'git:ref-reader-tool', 'declared', THandle> {
  readonly runner: NodeRunnerNode;
}

export interface GitCandidateComparisonToolNode<THandle = GitWorktreeHandle>
  extends BaseToolASTNode<'git:candidate-comparison-tool', 'declared', THandle> {
  readonly runner: NodeRunnerNode;
}
~~~

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
* **`git.cowWorktree({ repo, dir })`:** Compiles to a passive `GitCowWorktreeNode` (`readonly type: 'git:cow-worktree'`, `readonly capabilityTier: 'branchable'`, `readonly supportsCheckpoints: true`, `readonly supportsBranching: true`) member of `IsolationScopeASTNode<GitWorktreeHandle, GitScopeReceipt, GitSyncReceipt, 'branchable'>`, backed at runtime by `RuntimeExecutorRegistry.scopes['git:cow-worktree']` implementing `BranchableScope<GitWorktreeHandle, GitScopeReceipt, GitSyncReceipt> & CheckpointableScope<GitWorktreeHandle, GitScopeReceipt>`:
    * **Disjoint Sibling Directories (`<dir>/roots/<runId>` & `<dir>/forks/<runId>/<forkId>`), Isolated `.git/worktrees/<id>` Metadata, Portable CoW/Hardlink File Tree, `harness-meta.json` & Non-Destructive Crash Reattachment:**
        * Stores task root worktrees at `<dir>/roots/<runId>` and child fork worktrees at `<dir>/forks/<runId>/<forkId>` (disjoint sibling directories so child worktrees never nest inside a parent worktree's working tree or pollute `git status`, `cp -c`, or `git clean`). When `repo: '.'`, `<dir>/**`, `.harness/state.sqlite*`, and `.harness/lesson*` are implicitly excluded from all clones and checkpoints.
        * Registers every root and child worktree via `git worktree add --detach` so each worktree receives its own isolated `<hostRepo>/.git/worktrees/<worktreeId>` metadata directory (`HEAD`, `.git/index`, `index.lock`, and `harness-meta.json`) while sharing `<hostRepo>/.git/objects` and `refs`, and then populates `**/node_modules` and dirty working-tree files from the source handle via:
            1. `cp -c` (macOS APFS) or `cp --reflink=always` (Linux Btrfs / XFS) for zero-copy CoW file blocks.
            2. On standard Linux `ext4`, dirty working-tree files are always copied by value (`cp -a`, never hardlinked), while `**/node_modules` uses recursive monorepo-safe cloning (preserving symbolic links via `cp -P` for workspace links, hardlinking regular package files via `cp -al` without mutating inode permissions via `chmod a-w`—since `cp -al` shares inodes with the host repository and global `pnpm` store, and writes to `**/node_modules/**` are instead denied by `fs.codingTools` and `diffEffects`—and copying `**/node_modules/.prisma/**` by value; if `.lockfileGate('pnpm-lock.yaml')` misses, the hardlinked `node_modules` tree is unlinked/replaced before running `.setup(pnpm install)` so `pnpm` never mutates shared inodes).
        * Persists `{ baseRef, baseBranch, branchName, unresolvedConflictPaths, pendingParentHeadSha?, inFlightMerge?, inFlightCommitAndPush? }` in `<gitdir>/harness-meta.json` whenever initialized or updated (and inside `serializeCheckpoint` payloads), where `unresolvedConflictPaths` (`Readonly<Record<string, string>>`) maps each conflicted path to its conflict-materialized `${mode}:${sha256}` digest (using `'MISSING'` if the path was absent on disk when the conflict was recorded). `baseRef` is updated **only** when a conflicted `commitChild`, `syncChild`, `syncRoot`, or `commitAndPush` advances the worktree's base lineage (never mutated on `childHandle` during a clean `commitChild`).
        * **Automatic Pruning of Resolved `unresolvedConflictPaths`, `getConflictLease(handle)` & Automatic Parent Working-Tree Flush Before `forkChild` / `syncChild` / `commitChild`:** `git.cowWorktree` implements `BranchableScope.getConflictLease(handle)` by returning `fs.allowWriteGlobs(Object.keys(handle.unresolvedConflictPaths))` whenever `Object.keys(handle.unresolvedConflictPaths).length > 0` (and `undefined` when empty), which `@paraharness/core` calls after `forkChild`, `commitChild`, `syncChild`, and `syncRoot` to attach temporary conflict write leases without Core ever inspecting git-specific handle fields directly. Whenever `conflictCleanCheck`, `Automatic Parent Working-Tree Flush`, or `commitChild` inspects a handle, any entry in `unresolvedConflictPaths` whose current working-tree `${mode}:${sha256}` differs from its recorded conflict-time digest (or has been unlinked when the recorded digest was not `'MISSING'`) **and** contains no paired conflict markers (`<<<<<<<` / `=======` / `>>>>>>>`) is pruned from `unresolvedConflictPaths` in `<gitdir>/harness-meta.json`. Before `forkChild`, `syncChild`, or `commitChild` reads or reconciles against `parentHandle`, if `parentHandle` has dirty non-excluded working-tree mutations (for example, `coordinator` editing `packages/*/src/index.ts` or `TECH_DESIGN.md` via `edit_file`), `git.cowWorktree` first prunes resolved entries from `parentHandle.unresolvedConflictPaths` and automatically commits onto `parentHandle.HEAD` any non-excluded dirty files on `parentHandle` that are **not** in `parentHandle.unresolvedConflictPaths` (and contain no conflict markers), while keeping `parentHandle.baseRef` pinned to the run-start/prerequisite base SHA: for `syncChild` and `commitChild`, `@paraharness/core` already holds `ScopeLockManager.acquireWrite(parentHandle)` so `git.cowWorktree` flushes `parentHandle` directly; for `forkChild` (called under `@paraharness/core`'s `acquireRead(parentHandle)`), `git.cowWorktree` guards the dirty-tree check + flush commit with an internal per-`parentHandle` async mutex so the first `forkChild` in a parallel batch flushes `parentHandle` once without ever re-entering `ScopeLockManager.acquireWrite`. If `parentHandle.unresolvedConflictPaths` remains non-empty after pruning (e.g., from `syncRoot`), conflicted files are not auto-committed onto `parentHandle.HEAD`, and `forkChild` copies them into `childHandle` as dirty working-tree files along with `parentHandle.unresolvedConflictPaths` into `childHandle.unresolvedConflictPaths` (causing `@paraharness/core` to arm `conflictCheckArmed = true` on the child fork and attach `scope.getConflictLease(childHandle)`—i.e., `fs.allowWriteGlobs(Object.keys(childHandle.unresolvedConflictPaths))`—to the child's `agent-frame.activeLeases` and any enclosing `loop-frame.grantedLoopLeases`).
        * `.excludeFromCloneGlobs(['dist/**', '.next/**', 'coverage/**', '**/*.tsbuildinfo', '.harness-ephemeral/**', '**/node_modules/.cache/**', '**/node_modules/.vite/**', '**/node_modules/.vitest/**'])` omits path-embedded incremental build/test caches and ephemeral service directories during worktree cloning.
        * Injects `GIT_CEILING_DIRECTORIES=<path.dirname(worktreePath)>` (i.e., `<dir>/roots` for root worktrees and `<dir>/forks/<runId>` for fork worktrees, allowing any subdirectory inside `<worktreePath>` to walk up to `<worktreePath>/.git` while strictly forbidding Git from `chdir`-ing above `<worktreePath>` into `<hostRepo>`), `GIT_CONFIG_NOSYSTEM=1`, `GIT_OPTIONAL_LOCKS=0`, `GIT_CONFIG_COUNT=2`, `GIT_CONFIG_KEY_0=commit.gpgsign`, `GIT_CONFIG_VALUE_0=false`, `GIT_CONFIG_KEY_1=core.hooksPath`, and `GIT_CONFIG_VALUE_1=/dev/null` into all git and subprocess environments inside the worktree.
        * Implements `reattachRoot(runId, checkpoint?)` and `reattachChild(parentHandle, forkId, checkpoint?)` by rebinding `<dir>/roots/<runId>` (or `<dir>/forks/<runId>/<forkId>`) and reading `<gitdir>/harness-meta.json`: if `pendingParentHeadSha` is set (from a crash between `git read-tree -u -m` and `git update-ref HEAD` in `commitChild`), `reattachRoot` completes `git update-ref HEAD <pendingParentHeadSha>` and clears `pendingParentHeadSha` before any Automatic Parent Working-Tree Flush can run; if `inFlightMerge` is set (`{ targetHeadSha, mergedTreeSha, priorTreeSha, unresolvedConflictPaths }`, from a crash mid-materialization in a conflicted `commitChild`, `syncChild`, or `syncRoot`), `reattachRoot`/`reattachChild` completes materializing `mergedTreeSha` (`GIT_INDEX_FILE=<tmpIndex> git read-tree <mergedTreeSha>` + `git checkout-index -f -a` and unlinking paths in `baseRef` $\cup$ `priorTreeSha` absent from `mergedTreeSha`), updates `HEAD`, `.git/index`, and `baseRef` to `targetHeadSha`, persists `unresolvedConflictPaths`, and clears `inFlightMerge`; if `inFlightCommitAndPush` is set (from a crash mid-`commitAndPush`), `reattachRoot` executes `git rebase --abort` (if in progress), runs `git reset --hard <preStepHeadSha>`, restores `rootHandle.baseRef = preStepBaseRef`, and clears `inFlightCommitAndPush`; otherwise, if the worktree directory is intact on disk, its working tree is preserved as-is (never overwriting Turns `1..k` `edit_file` changes with Turn-0 `baseScopeCheckpoint`), restoring `agent-frame.pauseState.inFlightPreToolCheckpoint` if the process crashed mid-execution of a post-flight-guarded subprocess tool (and recreating from the latest host-pinned checkpoint/commit only if the worktree directory is missing on disk).
    * **Hardened `--no-renames` / `lstat` / `--force-remove` Git-Index Checkpoints & Worktree-Local `.git` Integrity (`serializeCheckpoint` / `restoreCheckpoint` / `diffEffects`):**
        * Configured via `.checkpointPolicy({ partitionMap, excludeGlobs: ['dist/**', '.next/**', 'coverage/**', '**/*.tsbuildinfo', '.harness-ephemeral/**', '**/node_modules/.cache/**', '**/node_modules/.vite/**', '**/node_modules/.vitest/**'], maxUntrackedFileSizeBytes: 1_048_576 })`.
        * `serializeCheckpoint(handle)` records `{ headSha, headRawContent, indexTreeSha, infoExcludeContent, meta, statusMap, treeSha, oversizedUntrackedBlobs }`, where `headSha` is `git rev-parse HEAD`, `indexTreeSha` is the tree OID of the live `<gitdir>/index`, `infoExcludeContent` is the raw content of `<gitdir>/info/exclude` (if present), `statusMap` maps every tracked dirty/deleted file and untracked file from `git status --porcelain=v2 -z --no-renames --untracked-files=all` (excluding paths ignored by `.gitignore` and `excludeGlobs`, while always tracking `**/.gitignore` itself) to `${mode}:${sha256}` (using `lstat(2)` + `readlink(2)` for symlinks, and copying—via CoW reflink or copy-by-value, never `cp -al` hardlinks—any pre-existing **untracked (`?`)** file exceeding `maxUntrackedFileSizeBytes` into `<gitdir>/harness-ckpt-blobs/` keyed by `${size}:${mtimeNs}:${sha256_head_tail}`). `treeSha` seeds a temporary `GIT_INDEX_FILE` via `git read-tree <headSha>`, stages **all tracked** modified/added files regardless of size plus untracked files $\le \text{maxUntrackedFileSizeBytes}$ via `git update-index --add --stdin -z`, stages deleted tracked files (`1 .D`) via `git update-index --force-remove --stdin -z`, and runs `git write-tree`.
        * Post-flight `diffEffects(fromCheckpoint, handle)` first verifies worktree-local `.git` integrity (`<gitdir>/HEAD` raw content, `git rev-parse HEAD`, the logical index tree OID `indexTreeSha`, `<gitdir>/info/exclude`, and `<gitdir>/harness-meta.json`—never global `git show-ref`, which concurrent worktrees legitimately mutate) against `fromCheckpoint`: if worktree-local `.git/**` metadata or `**/node_modules/**` was tampered with by a subprocess, `diffEffects` immediately invokes `restoreCheckpoint(handle, fromCheckpoint)` and throws a non-leasable scope integrity error. Otherwise, it queries `currentStatusMap` (if any `**/.gitignore` file was modified, added, or deleted relative to `fromCheckpoint.statusMap`, running `git status --porcelain=v2 -z --no-renames --untracked-files=all --ignored=matching` and excluding only paths that were already ignored at `fromCheckpoint` or match `excludeGlobs` so newly created untracked files hidden behind a `.gitignore` edit are included in `currentStatusMap` and `FsToolEffect.attributes.paths`) and computes the **symmetric difference** between `fromCheckpoint.statusMap` and `currentStatusMap` across all repository paths (so newly dirtied files, mode/symlink changes, and previously dirty files reverted back to `HEAD` by a subprocess are deterministically emitted as `FsToolEffect { mutatesScope: true, attributes: { mode: 'write', paths, existingPathsAtBaseRef, proposedContent } }`).
        * `restoreCheckpoint(handle, fromCheckpoint)` executes in strict 4-step order: (1) restores `<gitdir>/HEAD` (`fromCheckpoint.headRawContent` + `fromCheckpoint.headSha`), `<gitdir>/info/exclude` (`fromCheckpoint.infoExcludeContent`), and `<gitdir>/harness-meta.json` (`handle`'s metadata fields from `fromCheckpoint.meta`), resets `<gitdir>/index` to `fromCheckpoint.headSha`, and—before running `git status --porcelain=v2 -z --no-renames --untracked-files=all` to compute `currentStatusMap`—restores any tracked/checkpointed `**/.gitignore` files from `fromCheckpoint.treeSha` and unlinks any newly created untracked `**/.gitignore` files absent from `fromCheckpoint.treeSha` (so `currentStatusMap` is evaluated under `fromCheckpoint`'s exact `.gitignore` rules and any files committed when `HEAD` advanced or hidden behind a `.gitignore` edit appear in `currentStatusMap`); (2) unlinks every path in `symDiff(fromCheckpoint.statusMap, currentStatusMap)` absent from **both** `fromCheckpoint.treeSha` **and** `fromCheckpoint.oversizedUntrackedBlobs` (and for any path in `symDiff` that *is* present as a file/symlink in `fromCheckpoint.treeSha` or `oversizedUntrackedBlobs` but is currently a directory on disk via `lstat`, runs `rm -rf` on that directory first), pruning empty parent directories; (3) populates `<tmpIndex>` via `GIT_INDEX_FILE=<tmpIndex> git read-tree <fromCheckpoint.treeSha>` and materializes the `symDiff` paths present in `fromCheckpoint.treeSha` via `GIT_INDEX_FILE=<tmpIndex> git checkout-index -f -z --stdin` (falling back to `-a` only if worktree-local `.git` integrity failed), then restores the live `<gitdir>/index` to `fromCheckpoint.indexTreeSha` (`git read-tree <fromCheckpoint.indexTreeSha>` + `git update-index --refresh -q`); and (4) ensures parent directories exist (`fs.mkdir(dirname, { recursive: true })`) and copies back `fromCheckpoint.oversizedUntrackedBlobs` from `<gitdir>/harness-ckpt-blobs/` via CoW or copy-by-value.
    * **Side-Effect-Free Temporary-Index `inspect(handle)`, Stateless `git merge-tree --write-tree` `commitChild` & `syncChild`:**
        * `inspect(handle)` is **100% non-mutating** on the worktree's live `.git/index` and `HEAD`: if the working tree is clean (`statusMap.size === 0`) and `HEAD !== handle.baseRef` with `git merge-base --is-ancestor <handle.baseRef> HEAD` (e.g., immediately after `commitAndPush` or child fork commits), it reuses `headRef = git rev-parse HEAD` directly; otherwise, using the temporary `GIT_INDEX_FILE` staging protocol, it writes a deterministic commit object over `handle.baseRef` into the host object store (`git write-tree` + `git commit-tree -p <handle.baseRef>`), pins `refs/harness/candidates/<run-id>/<branch-index>` when inspecting a speculative branch, and computes `diffStat` and `mutatedFiles` against `handle.baseRef` while leaving the worktree's `HEAD` and working tree untouched.
        * `commitChild(child, parent)` first prunes any resolved entries from `child.unresolvedConflictPaths` (removing paths whose current working-tree `${mode}:${sha256}` differs from their conflict-time digest or was unlinked and contains no paired conflict markers) and immediately returns `status: 'conflict'` without mutating `parent` or re-merging whenever `child.unresolvedConflictPaths` remains non-empty after pruning or `conflictCleanCheck` finds paired conflict markers on `child`. Otherwise, it flushes any non-conflicted dirty working-tree files on `parent` to `parent.HEAD` ($C_1$), synthesizes `child`'s tree $T_{\text{child}}$ and temporary commit $C_{\text{child}} = \text{git commit-tree } T_{\text{child}} -p\ C_0$ (where $C_0 = \text{child.baseRef}$), and checks if $C_0 = C_1$. If $C_0 = C_1$, $C_{\text{target}} = C_{\text{child}}$; if `parent.HEAD` ($C_1$) has advanced past $C_0$, `commitChild` synthesizes $C_1' = \text{git commit-tree } C_1^{\text{tree}} -p\ C_0$ (so **both** commits passed to `git merge-tree` share $C_0$ as their sole immediate parent in the commit graph) and executes a stateless 3-way commit merge (`git merge-tree --write-tree $C_1' $C_{\text{child}}`, where Git 2.38+ is guaranteed to resolve $C_0$ as the exact 3-way merge-base without `--merge-base`, even when `syncRoot` or squash-merged `git rebase --onto` rewrote $C_1$'s real commit ancestry):
            * If clean ($C_0 = C_1$ or `git merge-tree` exit code 0, where $C_{\text{target}} = \text{git commit-tree } T_{\text{merged}} -p\ C_1$), `child.baseRef` is **not** mutated (keeping `child.baseRef = C_0` immutable on `childHandle`). For any path in `parentHandle.unresolvedConflictPaths` (or untracked collision) modified/added/deleted by $C_{\text{target}}$, `commitChild` first resets that path in `parentHandle`'s working tree to match $C_1$ (`git checkout-index -f -- <path>` if in $C_1$, or `unlink` if absent from $C_1$), persists `pendingParentHeadSha: $C_{\text{target}}` in `<parentGitDir>/harness-meta.json`, updates `parent`'s working tree and index via `git read-tree -u -m $C_1 $C_{\text{target}}`, advances `parent.HEAD` via `git update-ref HEAD $C_{\text{target}} $C_1`, and clears `pendingParentHeadSha` and any resolved paths from `parentHandle.unresolvedConflictPaths` in `<parentGitDir>/harness-meta.json`.
            * If conflicted (`git merge-tree` exit code 1), `parent` remains completely untouched; before modifying `child.HEAD`, `.git/index`, `child.baseRef`, or `child`'s working tree, `commitChild` persists `inFlightMerge: { targetHeadSha: C_1, mergedTreeSha: T_merged, priorTreeSha: T_child, unresolvedConflictPaths }` in `<childGitDir>/harness-meta.json`, populates `<tmpIndex>` via `GIT_INDEX_FILE=<tmpIndex> git read-tree $T_{\text{merged}}`, materializes the **entire** top-level merged tree $T_{\text{merged}}$ (line 1 of `git merge-tree` stdout, containing all non-conflicted changes from both $C_1$ and $C_{\text{child}}$ plus conflict-marked blobs for conflicted files) via `GIT_INDEX_FILE=<tmpIndex> git checkout-index -f -a` (while unlinking paths in $C_0 \cup T_{\text{child}}$ absent from $T_{\text{merged}}$) into `child`'s working tree with **zero** `.git/rebase-merge` state or unmerged index stages, and **only after** materialization and unlinking complete does it reset `child.HEAD` and `child`'s live `.git/index` cleanly to $C_1$, set `child.baseRef = C_1`, record **all** conflicted file paths mapped to their conflict-materialized `${mode}:${sha256}` digests (`'MISSING'` if absent on disk, covering text-marker content conflicts, Modify/Delete, Add/Add, and Binary conflicts) in `child.unresolvedConflictPaths` inside `<childGitDir>/harness-meta.json` (clearing `inFlightMerge`), and return `{ status: 'conflict', conflictedSummary, data }` (upon which `@paraharness/core` calls `scope.getConflictLease(child)`—returning `fs.allowWriteGlobs(Object.keys(child.unresolvedConflictPaths))`—and attaches it to the child's `agent-frame.activeLeases` and any enclosing `loop-frame.grantedLoopLeases`).
        * `syncChild(parent, pausedChild)` flushes any non-conflicted dirty working-tree files on `parent` to `parent.HEAD` ($C_1$), synthesizes **both** $C_1' = \text{git commit-tree } C_1^{\text{tree}} -p\ C_0$ and $C_{\text{child}} = \text{git commit-tree } T_{\text{child}} -p\ C_0$ from `pausedChild`'s working state over $C_0 = \text{pausedChild.baseRef}$ (guaranteeing $C_0$ as the exact 3-way merge-base via shared immediate parent ancestry even if $C_1$'s commit history was rewritten), runs `git merge-tree --write-tree $C_1' $C_{\text{child}}`, persists `inFlightMerge: { targetHeadSha: C_1, mergedTreeSha: T_merged, priorTreeSha: T_child, unresolvedConflictPaths }` in `<pausedChildGitDir>/harness-meta.json` before modifying `pausedChild.HEAD`, `.git/index`, `pausedChild.baseRef`, or the working tree, materializes $T_{\text{merged}}$ into `pausedChild`'s working tree via `GIT_INDEX_FILE=<tmpIndex> git read-tree $T_{\text{merged}}` + `GIT_INDEX_FILE=<tmpIndex> git checkout-index -f -a` (while unlinking paths in $C_0 \cup T_{\text{child}}$ absent from $T_{\text{merged}}$), and only after materialization and unlinking complete updates `pausedChild.HEAD`, `.git/index`, and `pausedChild.baseRef = C_1` and records all conflicted paths mapped to their conflict-materialized `${mode}:${sha256}` digests in `pausedChild.unresolvedConflictPaths` (clearing `inFlightMerge`). If any conflicts arise, `syncChild` returns `{ status: 'conflict', conflictedSummary, data }` (upon which `@paraharness/core` arms `conflictCleanCheck` and calls `scope.getConflictLease(pausedChild)`—returning `fs.allowWriteGlobs(Object.keys(pausedChild.unresolvedConflictPaths))`—to attach the temporary write lease to the child's `agent-frame.activeLeases` and any enclosing `loop-frame.grantedLoopLeases`). `conflictCleanCheck` (`GitCleanWorkingTreeNode`, `readonly type: 'git:clean-working-tree'`) first prunes any entry in `unresolvedConflictPaths` whose current working-tree `${mode}:${sha256}` differs from its recorded conflict-time digest (or was unlinked) and contains no paired conflict markers, and then fails if `unresolvedConflictPaths` remains non-empty or if either dirty/untracked files in `statusMap` **or** committed diffs in `git diff <baseRef> HEAD` contain paired conflict marker blocks (`^<{7} ` followed by `^={7}( |$)` and `^>{7} ` in the same file, never standalone Markdown `=======` lines).
    * **Stacked-PR Prerequisite Lineage (`syncRoot` & `release`):**
        * Before `release(handle)` deletes an ephemeral CoW worktree directory from disk, it pins root worktrees to `refs/harness/completed/roots/<run-id>` and child fork/speculative worktrees to `refs/harness/completed/forks/<run-id>/<fork-id>` in the host repository's git object store, removes the worktree registration (`git worktree remove --force`), and prunes ephemeral checkpoint blobs.
        * When `syncRoot(rootHandle, prereqReceipts)` reconciles a Task Root Worktree onto the tip prerequisite's `headRef` ($C_{\text{prereq}}$, after the runtime first restores `headScopeCheckpoint` via `scope.restoreCheckpoint(rootHandle, headScopeCheckpoint)` on `'SUSPENDED'` wakeup whenever `syncedToPrerequisiteCheckpoint` is not yet set and `headScopeCheckpoint` was recorded—a 0-file no-op on the normal path when `symDiff` is empty that rolls back any partial `HEAD` flush or working-tree materialization if a crash occurred mid-`syncRoot` before `baseRef` or `syncedToPrerequisiteCheckpoint` was updated), it first auto-flushes any non-conflicted dirty working-tree files on `rootHandle` onto `rootHandle.HEAD`, runs `git fetch origin`, checks whether the prerequisite's `branchName` (e.g., `fix/#102`) has been merged into `origin/main` (setting `rootHandle.baseBranch = prereqReceipt.branchName` if not yet merged), synthesizes **both** $C_{\text{prereq}}' = \text{git commit-tree } C_{\text{prereq}}^{\text{tree}} -p\ C_0$ and $C_{\text{root}} = \text{git commit-tree } T_{\text{root}} -p\ C_0$ over $C_0 = \text{rootHandle.baseRef}$ (so Git 2.38+ resolves $C_0$ as the exact 3-way merge-base via shared immediate parent ancestry even when squash-merged `git rebase --onto` rewrote $C_{\text{prereq}}$'s real commit ancestry), and runs `git merge-tree --write-tree $C_{\text{prereq}}' $C_{\text{root}}` followed by the same atomic `inFlightMerge` + stateless materialization protocol (`GIT_INDEX_FILE=<tmpIndex> git read-tree $T_{\text{merged}}` + `git checkout-index -f -a` while unlinking paths in $C_0 \cup T_{\text{root}}$ absent from $T_{\text{merged}}$, with zero `.git/rebase-merge` state) before advancing `rootHandle.HEAD`, `.git/index`, and `rootHandle.baseRef` to $C_{\text{prereq}}$ and recording any conflicted paths mapped to their `${mode}:${sha256}` digests in `rootHandle.unresolvedConflictPaths` inside `<gitdir>/harness-meta.json` (clearing `inFlightMerge`).
    * **Reconciliation Strategies (`.reconcileStrategy('rebase-onto-base' | 'batch-merge-train', opts)`):**
        * `'rebase-onto-base'` (for PR-opening lanes): Rebases each completed Task Root Worktree via `git rebase --onto origin/${resolvedBaseBranch} <rootHandle.baseRef> HEAD` and runs `verifyWith` so each feature branch PR contains only its own commits even when a prerequisite PR was squash-merged into `origin/main`.
        * `'batch-merge-train'` (for direct branch-landing / auto-merge queues, or `git.mergeQueue(id, opts)` compiling to `GitMergeQueueNode` with `readonly type: 'git:merge-queue'`): Speculatively constructs a cumulative rebase chain ($R_1, R_1 + R_2, \dots, R_1 + \dots + R_k$, up to `maxBatchSize`) across completed runs landing into the target branch, runs `verifyWith` once on the cumulative head $R_k$ (fast-tracking partition-disjoint changes), and bisects only if $R_k$ fails verification.
* **`git.snapshotAndReset()`:** Compiles to a passive `GitSnapshotAndResetNode` (`readonly type: 'git:snapshot-and-reset'`) member of `AbortHookASTNode<GitWorktreeHandle, GitAbortMeta>` dispatched via `RuntimeExecutorRegistry.abortHooks['git:snapshot-and-reset']`. Idempotently synthesizes a snapshot commit of the current working tree over `handle.baseRef` to `refs/harness/aborted/<run-id>/<stepExecId>` in the host repository (if the working tree has zero diff against `handle.baseRef` and `refs/harness/aborted/<run-id>/<stepExecId>` already exists from a pre-crash attempt, returns the existing ref without overwriting it), resets the worktree to clean `handle.baseRef` (`git reset --hard <handle.baseRef>` + `git clean -fd`), and clears `handle.unresolvedConflictPaths = {}` in `<gitdir>/harness-meta.json`.
* **`git.keepWorktree()` & `git.resetWorktree()` / `git.discardBranch()`:** Compile to passive `GitKeepWorktreeNode` (`readonly type: 'git:keep-worktree'`, `readonly resetsRunOverlay: false`) and `GitDiscardBranchNode` (`readonly type: 'git:discard-branch'`, `readonly resetsRunOverlay: true`, constructed via `git.resetWorktree()` or its alias `git.discardBranch()`) members of `ScopeRewindHookASTNode<GitWorktreeHandle>` dispatched via `RuntimeExecutorRegistry.rewindHooks` for `.rewindTo()`: `git.keepWorktree()` preserves `rootHandle`'s current working tree, `HEAD`, and `baseRef` in-place across the rewind, whereas `git.resetWorktree()` / `git.discardBranch()` restores `rootHandle` to `targetStepBaseScopeCheckpoint` via `scope.restoreCheckpoint(rootHandle, targetStepBaseScopeCheckpoint)`.
* **`git.publicSurfaceCrossTester({ runner?, partitionMap })` & `git.patchEquivalence(...)`:** Compile to passive `GitPublicSurfaceCrossTesterNode` (`readonly type: 'git:public-surface-cross-tester'`, defaulting `runner` to `DEFAULT_NODE_RUNNER_AST_NODE`) and `GitPatchEquivalenceNode` (`readonly type: 'git:patch-equivalence'`) members of `CrossVerifierASTNode` dispatched via `RuntimeExecutorRegistry.crossVerifiers`. `git.publicSurfaceCrossTester` parses AST imports of newly added test files across speculative worktrees and cross-executes tests that import exclusively from `boundaryGlobs`.
* **`git.refReaderTools(runner?)` & `git.candidateComparisonTools(runner?)` & `git.commitAndPush(id, opts)`:**
    * `git.refReaderTools(runner?)` returns passive `GitRefReaderToolNode` (`readonly type: 'git:ref-reader-tool'`, `readonly effectTracking: 'declared'`, defaulting `runner` to `DEFAULT_NODE_RUNNER_AST_NODE`) descriptors exposing read-only git object inspection tools (`readRefFile`, `diffRefs`, `listRefFiles`) implemented via pure `git show` / `git diff-tree` against the object store (`describeEffects: () => []`) so `coordinator` can inspect `refs/harness/aborted/<run-id>/<stepExecId>` snapshots after a fast-path `scopeTripwire` or `contractViolation` reset.
    * `git.candidateComparisonTools(runner?)` returns passive `GitCandidateComparisonToolNode` (`readonly type: 'git:candidate-comparison-tool'`, `readonly effectTracking: 'declared'`, defaulting `runner` to `DEFAULT_NODE_RUNNER_AST_NODE`) descriptors exposing candidate inspection and benchmark tools (`diffCandidates`, `readCandidateFile`, `evalInCandidates`) capable of reading `refs/harness/candidates/<run-id>/<branch-index>` (and running benchmarks in live candidate worktrees via `ctx.candidateHandles` and `ctx.scope` during `candidateArbiter` evaluation and `refineWinnerWhen` cross-pollination prior to post-commit `release()`, where `evalInCandidates` wraps each candidate worktree command in `const ckpt = await scope.serializeCheckpoint(candidateHandle)` + `try/finally { await scope.restoreCheckpoint(candidateHandle, ckpt) }` so candidate worktrees remain bit-for-bit clean prior to `commitChild`).
    * `git.commitAndPush(id, { branch, message }).input(schema).runner(runner).env(envRecord)` compiles to a passive `GitCommitAndPushNode<TIn>` (`readonly type: 'git:commit-and-push'`) member of `StepASTNode<TIn, void, GitWorktreeHandle>` dispatched via `RuntimeExecutorRegistry.steps['git:commit-and-push']` (`NodeExecutor<GitCommitAndPushNode<TIn>, TIn, void, StepExecutionContext<GitWorktreeHandle>>`): acquires subprocess slots via `ctx.getRunner(node.runner)`, reads the enclosing scope's reconciliation configuration via `ctx.scopeNode?.reconcileStrategy`, first auto-flushes/commits any uncommitted working-tree changes onto `rootHandle.HEAD` (so `preStepHeadSha = git rev-parse HEAD` is a commit object capturing 100% of the step's edits), saves `inFlightCommitAndPush: { preStepHeadSha, preStepBaseRef }` in `<gitdir>/harness-meta.json`, runs `git fetch origin`, and wraps the squash + rebase + verification + push sequence in a `try/catch` that (like `reattachRoot` on boot if `inFlightCommitAndPush` is present) executes `git rebase --abort` (if in progress), runs `git reset --hard <preStepHeadSha>`, and restores `rootHandle.baseRef = preStepBaseRef` on any failure so lane step retries never wipe out uncommitted worker edits or leak upstream commits. Inside the `try` block, it squashes and commits all changes in `rootHandle` since `rootHandle.baseRef` using `message(input)`, verifies whether `scopeReceipt.baseBranch` has already merged into `origin/main` (falling back to `resolvedBaseBranch = 'main'` if merged and deleted on the remote, or throwing an error if the prerequisite PR was closed without merging), executes `ctx.scopeNode?.reconcileStrategy` (`'rebase-onto-base'`, `{ verifyWith }`) via `git rebase --onto origin/${resolvedBaseBranch} <rootHandle.baseRef> HEAD`, pushes `HEAD` to `branch(input)` using `git push --force-with-lease`, and updates `rootHandle.baseRef = rev-parse(origin/${resolvedBaseBranch})` (the upstream commit SHA on `origin/${resolvedBaseBranch}`, never `pushedCommitSha`), `rootHandle.baseBranch = resolvedBaseBranch`, `rootHandle.branchName = branch(input)`, and `rootHandle.headRef = pushedCommitSha` in-place on `rootHandle` (clearing `inFlightCommitAndPush` in `<gitdir>/harness-meta.json`) so subsequent steps (`publishPr`), `recordRunTerminalReceipt`, and any `steerSignal` `.rewindTo('execute-work', { onRewind: git.keepWorktree() })` inspect the exact pushed commit and full feature diff against `origin/${resolvedBaseBranch}`.

## 4.5 `@paraharness/markdown`, `@paraharness/sqlite`, `@paraharness/postgres`, `@paraharness/github`, `@paraharness/slack`

~~~ts
export interface MarkdownFrontmatterSourceNode<T = unknown>
  extends BaseSourceASTNode<'markdown:frontmatter', T> {
  readonly pathOrGlob: string;
}

export interface MarkdownSectionSourceNode<T = unknown>
  extends BaseSourceASTNode<'markdown:section', T> {
  readonly path: string;
  readonly heading: string;
}

export interface SqliteLedgerNode extends BaseLedgerStoreASTNode<'sqlite:ledger'> {
  readonly uri: string;
  readonly compaction?: CompactionConfigNode;
}

export interface PostgresLedgerNode extends BaseLedgerStoreASTNode<'postgres:ledger'> {
  readonly uri: string | EnvRef;
  readonly compaction?: CompactionConfigNode;
}

export interface SqliteTopologyNode extends BaseTopologyStoreASTNode<'sqlite:topology'> {
  readonly uri: string;
}

export interface PostgresTopologyNode extends BaseTopologyStoreASTNode<'postgres:topology'> {
  readonly uri: string | EnvRef;
}

export interface SqliteLessonsNode extends BaseLessonStoreASTNode<'sqlite:lessons'> {
  readonly uri: string;
}

export interface PostgresLessonsNode extends BaseLessonStoreASTNode<'postgres:lessons'> {
  readonly uri: string | EnvRef;
}

export interface SqliteRulesSourceNode
  extends BaseSourceASTNode<'sqlite:global-rules', readonly GlobalRule[]> {
  readonly uri: string;
  readonly table: string;
}

export interface PostgresRulesSourceNode
  extends BaseSourceASTNode<'postgres:global-rules', readonly GlobalRule[]> {
  readonly uri: string | EnvRef;
  readonly table: string;
}

export interface GithubIssuesTrackerNode<TExternal = unknown, TExternalState extends string = string>
  extends BaseTrackerASTNode<'github:issues', TExternal, TExternalState> {
  readonly repo: string;
  readonly token: string | EnvRef;
  readonly labels?: readonly string[];
}

export interface GithubWebhookStreamNode<TEvent = unknown>
  extends BaseStreamSourceASTNode<'github:webhook-stream', TEvent> {
  readonly repo?: string;
  readonly port?: number;
  readonly path?: string;
  readonly secret: string | EnvRef;
  readonly events: readonly string[];
}

export interface GithubCreateOrUpdatePrNode<TIn = unknown, TOut = unknown, THandle = unknown>
  extends BaseDomainStepASTNode<'github:create-or-update-pr', TIn, TOut, THandle> {
  readonly repo: string;
  readonly token: string | EnvRef;
  readonly branch: (input: TIn) => string;
  readonly baseBranch?: (input: TIn) => string;
  readonly title: (input: TIn) => string;
  readonly body: (input: TIn) => string;
}

export interface SlackApproverNode
  extends BaseHumanChannelASTNode<'slack:approver', 'bidirectional'>,
    BaseControlPlaneASTNode<'slack:approver'> {
  readonly appToken: string | EnvRef;
  readonly botToken: string | EnvRef;
  readonly channel: string | EnvRef;
}

export interface SlackNotifierNode extends BaseHumanChannelASTNode<'slack:notifier', 'notify-only'> {
  readonly webhookUrl: string | EnvRef;
}
~~~

* **`@paraharness/markdown`:** `md.globalRules(glob)`, `md.scopedRule(path)`, `md.scopedRules(glob)`, `md.skill(path)`, `md.skills(glob)` compile to passive `MarkdownFrontmatterSourceNode` (`readonly type: 'markdown:frontmatter'`) and `MarkdownSectionSourceNode` (`readonly type: 'markdown:section'`) members of `SourceASTNode` (always resolving control-plane rule and skill paths against the immutable host repository root via `RuntimeExecutorRegistry.sources`).
* **`@paraharness/sqlite` & `@paraharness/postgres`:** `ledger(uri)` (`SqliteLedgerNode` `'sqlite:ledger'` / `PostgresLedgerNode` `'postgres:ledger'`), `topologyStore(uri)` (`SqliteTopologyNode` `'sqlite:topology'` / `PostgresTopologyNode` `'postgres:topology'`), `lessonStore(uri)` (`SqliteLessonsNode` `'sqlite:lessons'` / `PostgresLessonsNode` `'postgres:lessons'`), and `globalRules(uri, { table })` (`SqliteRulesSourceNode` `'sqlite:global-rules'` / `PostgresRulesSourceNode` `'postgres:global-rules'`), backed by their corresponding runtime stores in `RuntimeExecutorRegistry`.
* **`@paraharness/github`:** `github.issues(opts)` (`GithubIssuesTrackerNode` `'github:issues'`), `github.webhookStream(opts)` (`GithubWebhookStreamNode` `'github:webhook-stream'`, defaulting `port` to `3000`, `path` to `'/webhooks/github'`, and filtering incoming webhook payloads by `repo` when specified), and `github.createOrUpdatePr(id, opts)` (`GithubCreateOrUpdatePrNode` `'github:create-or-update-pr'`), backed by `RuntimeExecutorRegistry.trackers`, `RuntimeExecutorRegistry.streamSources`, and `RuntimeExecutorRegistry.steps`.
* **`@paraharness/slack`:** `slack.webhook(url)` (`SlackNotifierNode` with `readonly type: 'slack:notifier'` and `readonly interactionMode: 'notify-only'`, one-way notification adapter) and `slack.bot(opts)` (`SlackApproverNode` with `readonly type: 'slack:approver'` and `readonly interactionMode: 'bidirectional'`, interactive `HumanAdapter` & `ControlPlaneAdapter` supporting `requestDecision` and `cancelDecision` via `RuntimeExecutorRegistry.humanChannels` and `RuntimeExecutorRegistry.controlPlanes`).

---

# 5. Domain-Generality Verification: Non-Coding Financial Harness Example

Because `@paraharness/core` separates Tier-1 `IsolationScopeASTNode<THandle, TReceipt, never, 'scope'>` (backed by `IsolationScope`: `acquireRoot`, `reattachRoot`, `inspect`, `release`) from `'checkpointable'` (`CheckpointableScope`) and `'branchable'` (`BranchableScope`), and exposes the open, declaration-mergeable `CustomDomainASTRegistry` interface, non-coding domain adapters (such as `@paraharness/stripe` and `@paraharness/netsuite`) augment `CustomDomainASTRegistry`, emit passive AST nodes with `capabilityTier: 'scope'` and `effectTracking: 'declared'`, and implement only the base transactional scope driver without faking git rebase semantics:

~~~ts
import {
  P,
  z,
  type BaseAbortHookASTNode,
  type BaseCheckASTNode,
  type BaseIsolationScopeASTNode,
  type BasePolicyGuardASTNode,
  type BaseToolASTNode,
} from '@paraharness/core';
import { claude } from '@paraharness/claude';
import { postgres } from '@paraharness/postgres';
import { slack } from '@paraharness/slack';
import {
  stripe,
  type StripeMaxRefundGuardNode,
  type StripeReadToolNode,
} from '@paraharness/stripe';
import {
  netsuite,
  type DraftJournalReceipt,
  type NetSuiteBalanceZeroCheckNode,
  type NetSuiteClosedPeriodGuardNode,
  type NetSuiteDraftHandle,
  type NetSuiteDraftScopeNode,
  type NetSuiteJournalToolNode,
  type NetSuiteRollbackAbortHookNode,
} from '@paraharness/netsuite';

// Third-party adapter packages augment CustomDomainASTRegistry so their passive AST nodes
// become first-class members of DomainASTNode, ASTNode, and RuntimeExecutorRegistry:
declare module '@paraharness/core' {
  interface CustomDomainASTRegistry {
    scope: NetSuiteDraftScopeNode;
    guard: NetSuiteClosedPeriodGuardNode | StripeMaxRefundGuardNode;
    abortHook: NetSuiteRollbackAbortHookNode;
    tool: StripeReadToolNode | NetSuiteJournalToolNode;
    check: NetSuiteBalanceZeroCheckNode;
  }
}

const discrepancyItem = z.object({
  discrepancyId: z.string(),
  accountRegion: z.enum(['us-east', 'eu-west']),
  varianceUsd: z.number(),
});

const settlementReceipt = z.object({
  journalEntryId: z.string(),
  reconciledAmountUsd: z.number(),
});

const highValueApprovalRequest = P.interrupt('high-value-approval').payload(
  z.object({ proposedJournalId: z.string(), amountUsd: z.number(), reason: z.string() }),
);

const reconcileLimitExceeded = P.interrupt('reconcile-limit-exceeded').payload(
  z.object({ summary: z.string() }),
);

const financeController = P.human('finance-controller')
  .keepAliveSeconds(60)
  .notify(
    slack.bot({
      appToken: P.env('FINANCE_SLACK_APP_TOKEN'),
      botToken: P.env('FINANCE_SLACK_BOT_TOKEN'),
      channel: P.env('FINANCE_SLACK_CHANNEL_ID'),
    }),
  );
const opus = claude.model('opus', { id: 'claude-opus-4-6' });

// Chained policy clauses operate pre-flight over static ToolDriver.describeEffects() (effectTracking: 'declared')
// on Stripe/NetSuite API tools: Clause 1 unconditionally denies closed-period postings in-band; Clause 2
// intercepts refunds > $500 in PendingToolBatch (keeping the draft journal intact while awaiting
// financeController) and replays automatically when allowRefundUpToUsd(10_000) is granted. Turn-limit
// exhaustion raises a dedicated reconcileLimitExceeded interrupt after rolling back the draft journal.
const autoReconcilePolicy = P.policy('auto-reconcile-bounds')
  .guard(netsuite.forbidClosedPeriodPosting())
  .onViolation('deny-with-error')
  .guard(stripe.maxRefundGuardUsd(500))
  .onViolation('raise-interrupt', highValueApprovalRequest, (violation) => ({
    proposedJournalId: String(violation.violatedEffects[0]?.attributes?.journalId ?? 'draft'),
    amountUsd: Number(violation.violatedEffects[0]?.attributes?.amountUsd ?? 0),
    reason: violation.violationSummary,
  }))
  .maxTurns(6)
  .onAbort(netsuite.rollbackDraftJournal())
  .onLimitExceeded(($l) =>
    $l.flushWithInterrupt(reconcileLimitExceeded).onAbort(netsuite.rollbackDraftJournal()),
  );

const manualReconcilePolicy = P.policy('manual-reconcile-bounds')
  .guard(netsuite.forbidClosedPeriodPosting())
  .onViolation('deny-with-error')
  .maxTurns(15)
  .onAbort(netsuite.rollbackDraftJournal());

const reconciliationAgent = P.agent('reconciler')
  .model(opus)
  .policy(autoReconcilePolicy)
  .tools(stripe.readTools(), netsuite.journalTools())
  .instructions('Reconcile the regional ledger variance against Stripe settlement records.')
  .beforeStop(netsuite.balanceZeroCheck())
  .input(discrepancyItem)
  .partitions((item) => [item.accountRegion])
  .output(settlementReceipt);

export const manualEscalationAgent = P.agent('manual-reconcile-escalator')
  .model(opus)
  .policy(manualReconcilePolicy)
  .tools(stripe.readTools(), netsuite.journalTools())
  .instructions('Complete the escalated reconciliation using the prior failure summary and controller guidance.')
  .beforeStop(netsuite.balanceZeroCheck())
  .input(discrepancyItem.extend({ priorFailureSummary: z.string() }))
  .partitions((item) => [item.accountRegion])
  .output(settlementReceipt);

export const reconciliationFlow = P.flow('reconcile-discrepancy')
  .input(discrepancyItem)
  .scope(netsuite.draftJournalScope()) // Compiles to IsolationScopeASTNode with capabilityTier: 'scope' (backed by Tier-1 IsolationScope<NetSuiteDraftHandle, DraftJournalReceipt>)
  .step('attempt-reconcile', reconciliationAgent, ($s) =>
    $s
      .onInterrupt(highValueApprovalRequest, ($intr) =>
        $intr
          .ask(financeController, z.object({ approved: z.boolean(), note: z.string() }))
          .elevateLeaseWhen((d) => d.approved, () => stripe.allowRefundUpToUsd(10_000))
          .resumeWith((d) => `Controller decision: ${d.approved ? 'Approved' : 'Denied'} (${d.note})`),
      )
      .onInterrupt(reconcileLimitExceeded, ($limit) =>
        $limit
          .onAbort(netsuite.rollbackDraftJournal())
          .replaceWith(manualEscalationAgent, (item, payload) => ({
            ...item,
            priorFailureSummary: payload.summary,
          })),
      ),
  )
  .exit('done');
~~~