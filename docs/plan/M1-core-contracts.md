# Milestone M1 — Workspace Bootstrap & `@paraharness/core` Pure AST, Ports, Schemas, Topology & Fluent Builders (`P.*`)

## 1. Scope & Ownership (`owned_dirs` & `forbidden_dirs`)

- **Milestone**: `M1` (Wave 1a — Sequential Core Spine `b`)
- **Package**: `@paraharness/core` (`packages/core`), `@paraharness/lockfile` (`packages/lockfile`), and Monorepo Workspace Manifests
- **`owned_dirs`**:
  - Root workspace configuration: `pnpm-workspace.yaml`
  - Package manifests and TypeScript configs for all 16 workspace packages: `packages/{lockfile,core,sqlite,postgres,fs,markdown,node,git,claude,openai,gemini,github,slack,stripe,netsuite,integration}/{package.json,tsconfig.json}`
  - Standalone file lock package: `packages/lockfile/**` (`acquireFileLock`, `withFileLock` backed by `p-queue` and cross-process atomic `open(..., 'wx')` + `utimes` heartbeat + dead-PID/stale reclamation)
  - `@paraharness/core` contract, AST, port, schema, topology, builder, and namespace files:
    - `packages/core/src/ast/**`
    - `packages/core/src/ports/**`
    - `packages/core/src/schemas/**`
    - `packages/core/src/topology/**`
    - `packages/core/src/builders/**`
    - `packages/core/src/p-namespace-contract.ts`
    - `packages/core/src/p-namespace.ts`
    - `packages/core/src/index.ts`
    - `packages/core/src/runtime/index.ts` (initial barrel re-exporting `createExecutorRegistry` and runtime port contracts; expanded in `M2`)
  - `@paraharness/lockfile` test suite:
    - `packages/lockfile/test/with-file-lock.test.ts`
  - `@paraharness/core` M1 test suites and fixtures:
    - `packages/core/test/fixtures/**`
    - `packages/core/test/ast-and-schemas.test.ts`
    - `packages/core/test/topology-and-builders.test.ts`
    - `packages/core/test/flow-and-validation.test.ts`
- **`forbidden_dirs`**:
  - `packages/core/src/runtime/**` (except `packages/core/src/runtime/index.ts`, which is owned by `M1` in Wave 1a and expanded by `M2` in Wave 1b)
  - `packages/{sqlite,postgres,fs,markdown,node,git,claude,openai,gemini,github,slack,stripe,netsuite,integration}/src/**`
  - `packages/{sqlite,postgres,fs,markdown,node,git,claude,openai,gemini,github,slack,stripe,netsuite,integration}/test/**`
  - Pre-existing root files (`package.json`, `eslint.config.mjs`, `tsconfig.base.json`, `vitest.config.ts`), `.agents/**`, `.claude/**`, `docs/**`

### Approved External Libraries & Native Primitives (`CLAUDE.MD` #2 & `docs/CODING_GUIDELINES.md` Rule 3.5)

| Concern | Selected Package / Built-in | Version & License | Evaluated Alternatives & Rejection Reason | Lifecycle & Native/WASM Trade-offs | Owner Approval Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Schema validation & JSON Schema conversion (`zodToJsonSchema`) | `zod` (`z.toJSONSchema()`) | `^4.6.7` (npm `4.6.7`, `MIT`, `0` deprecated, `0` CVEs) | `zod-to-json-schema` (deprecated/superseded by native Zod v4 `z.toJSONSchema()`); hand-rolled recursive Zod `_def` walker (forbidden by Rule 3.5) | Pure TypeScript, zero native/WASM overhead; covariant `ZodType<out Output, out Input>` preserves `.default()` output inference across all AST/builder generics | Approved (`Rule 3.5`) |
| Topology DAG cycle detection & transitive traversal (`P.topology`, `dependentsOf`, `affectedBy`) | `@dagrejs/graphlib` (`Graph`, `alg.findCycles`, `alg.preorder`) | `^4.0.7` (npm `4.0.7`, `MIT`, `0` deprecated, `0` CVEs) | `graphology` (multi-package plugin sprawl for simple cycle/preorder queries); hand-rolled 3-state DFS (forbidden by Rule 3.5) | Pure JS in-memory directed graph; deterministic cycle detection at `.toAST()` build time and transitive dependent queries | Approved (`Rule 3.5`) |
| In-process per-path FIFO lock serialization (`@paraharness/lockfile`) | `p-queue` (`new PQueue({ concurrency: 1 })`) | `^9.1.0` (`9.3.5` locked in `pnpm-lock.yaml`; npm `10.0.0` — pinned to `^9.1.0` / `9.3.5` for Node `>=22.0.0` engine compatibility and `PQueue` `idle`/`next` event semantics without mutating locked workspace manifests, `MIT`, `0` deprecated, `0` CVEs) | Hand-rolled promise-chain mutex map (forbidden by Rule 3.5) | Pass a queued-wait-only `AbortController` signal to `PQueue.add` and detach caller `AbortSignal` listener inside the task callback before critical-section execution (`docs/lessons/BUILDER.md`); delete map entry when `queue.size === 0 && queue.pending === 0` | Approved (`Rule 3.5`) |
| Cross-process advisory lockfile (`@paraharness/lockfile`) | `node:fs/promises` (`open(lockPath, 'wx')`, `utimes`, `stat`, `readFile`, `unlink`) + `process.kill(pid, 0)` | Built-in Node.js `>=22` (`MIT`) | `proper-lockfile` (unmaintained since 2020, timer-race issues); copy-pasting lock helpers across `packages/fs` and `packages/git` (forbidden by `CLAUDE.MD` #2 Step 4) | Standalone `packages/lockfile` workspace package; `.unref()`ed `setInterval` heartbeat (`utimes`), dead-PID (`ESRCH`) and stale-`mtime` reclamation, and deterministic `try / finally` handle close + unlink | Approved (`Rule 3.5`) |

---

## 2. Normative Specification & Coding Sample Grounding

| Normative Source | Section & Exact Line Range | Grounded Scope in `M1` |
| :--- | :--- | :--- |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §1.1–§1.2 (`lines 3–34`) | Package boundaries (`line 13`) and Declarative Compilation & Serialization Invariants 1–6 (`lines 26–34`): pure passive discriminated-union AST nodes (`readonly type: '...'`), fluent `AstBuilder<TNode>.toAST()`, static build-time validation of `capabilityTier`, `effectTracking`, and `interactionMode` without duck-typing runtime methods, symbolic `P.env(key)` (`EnvRef`), and zero execution methods on AST nodes. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §2.1 (`lines 44–680`) | Pure Passive AST Foundation: `ASTNode`, `AstBuilder<TNode>`, `MaybeBuilder<TNode>`, `extractAST`, `SourceValue<T>`, `MaybeSource<T>`, `EnvRef`, `SignalNode`, `SignalBuilder`, `InterruptNode`, `InterruptBuilder`, `CrossVerifierBuilder`, `TopologyBuilder`, `dependentsOf`, `affectedBy`, `StreamNode`, `PoolStrategyNode`, `PoolNode`, `PrefixGroupNode`, `TopologyNode`, `ScopedRuleNode`, `RulesNode`, `SkillNode`, `LessonsNode`, `PolicyViolation`, `PolicyGuardClauseNode`, `PolicyNode`, `HumanNode`, `ScopedHumanTargetNode`, `CompactionConfigNode`, `CommandNode`, `ForkCapabilityNode`, `SpeculateCapabilityNode`, `MutatePlanCapabilityNode`, `EscalateCapabilityNode`, `AgentCapabilitiesNode`, `ChildInterruptHandlerNode`, `InterruptHandlerNode`, `AgentNode`, `LoopNode`, `FlowStepNode`, `FlowBranchNode`, `FlowNode`, `LaneNode`, `HarnessNode`, and `CoreASTNode`. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §2.2 (`lines 682–1092`) | Domain-Agnostic Base AST Node Contracts (`ScopeCapabilityTier`, `BaseIsolationScopeASTNode`, `BaseDomainStepASTNode`, `BaseStepASTNode`, `BaseToolASTNode`, `BaseCheckASTNode`, `BaseServiceASTNode`, `BasePolicyGuardASTNode`, `BaseQuotaTripwireASTNode`, `BaseTelemetryCollectorASTNode`, `BaseAbortHookASTNode`, `BaseScopeRewindHookASTNode`, `BaseCrossVerifierASTNode`, `BaseSourceASTNode`, `BaseAccountSeatASTNode`, `BaseModelASTNode`, `BaseLedgerStoreASTNode`, `BaseTopologyStoreASTNode`, `BaseLessonStoreASTNode`, `BaseTrackerASTNode`, `BaseStreamSourceASTNode`, `BaseHumanChannelASTNode`, `BaseControlPlaneASTNode`, `BaseEffectMatcherASTNode`, `BaseRunnerPoolASTNode`), `CustomDomainASTRegistry`, `CustomDomainAST<K>`, and all workspace category unions (`IsolationScopeASTNode` through `DomainASTNode`). |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §2.3–§2.8 (`lines 1094–2162`) | Universal `NodeExecutor`, `NodeExecutorMap`, `RuntimeDriverContext`, `StepExecutionContext`, `RuntimeExecutorRegistry`, `RuntimeExecutorRegistrySlice`, `HarnessRuntime`, `HarnessRuntimeOptions`, `HarnessExecutionEngine`, `ResolutionContext`, `ToolEffect`, `LeaseDelta`, `RunnerDriver`, `ExecutionContext`, `ToolDriver`, `ServiceSession`, `ReconcileResult`, `IsolationScope`, `CheckpointableScope`, `BranchableScope`, `CanonicalMessage`, `WireFrameRecord`, `WireToolSchema`, `CompiledWirePrefix`, `ForkContext`, `ModelDriver`, `UniversalStepTelemetry`, `PendingPreFlightCall`, `PendingToolBatch`, `AgentPauseState`, `ContinuationFrame`, `SuspendedForkRecord`, `LedgerStore`, `TopologyPartitionState`, `TopologyStore`, `LessonOutcome`, `DistilledLessonCandidate`, `LessonRecord`, `LessonStore`, `TrackerAdapter`, `StreamSource`, `HumanAdapter`, `ControlPlaneAdapter`, and `HarnessRuntimeController`. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §3.1–§3.10 (`lines 2166–2655`) | `PoolCandidateState`, `PoolSelectionContext`, `PoolSelectorFn` (`lines 2181–2206`), `ScopePredicateSchema`, `ScopePredicate`, `GlobalRuleSchema`, `GlobalRule`, `ScopedRuleSchema`, `ScopedRule` (`lines 2257–2280`), `SpeculationCandidateSchema`, `SpeculationInputSchema` (`lines 2416–2484`), `ResumeForkInputSchema` (`lines 2557–2561`), `BudgetApprovalSchema` (`lines 2639–2642`), `DistilledLessonCandidate` (`lines 2084–2088`), and all fluent `P.*` builder chains, `.withPolicy()` / `.withTools()` canonical `roleKey` derivation, and static build-time validations. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §4.1–§4.5 (`lines 2658–3218`) | Concrete passive `DomainASTNode` interfaces (`ClaudeAccountSeatNode` through `SlackNotifierNode`) exported from `@paraharness/core` so `M3a..M3f` have zero cross-adapter imports. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §5 (`lines 3221–3363`) | `CustomDomainASTRegistry` declaration merging and Tier-1 `IsolationScope` (`capabilityTier: 'scope'`) static build-time validation. |
| [`docs/CODING_SAMPLE.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_SAMPLE.md) | §3.1 (`lines 106–115`) & §6 (`lines 176–1208`) | All `P.*` builder invocations in `engineering-harness.ts`, `repoTopology.dependentsOf` / `repoTopology.affectedBy`, `P.SpeculationInputSchema`, `P.BudgetApprovalSchema`, and re-exported `z` from `@paraharness/core`. |

---

## 3. Planned Module Decomposition & Public Exports (`packages/lockfile/src/**` & `packages/core/src/**`)

Every file, class, method, and function in `packages/lockfile/src/**`, `packages/core/src/**`, and `packages/core/test/fixtures/**` adheres to [`docs/CODING_GUIDELINES.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_GUIDELINES.md) §§1–5: each file, class, method, and function has **one clear responsibility at one uniform level of abstraction** (Rules 1.1–1.8 & 3.1–3.4), single-kind entity files per Rule 1.1, 1 root `interface` per file plus sub-interfaces reachable via `TSPropertySignature`, `TSIndexSignature`, `extends`, or `TSMethodSignature` parameter/return types per Rule 1.2, 1 builder factory function per `create-*-builder.ts` file with optional co-located dedicated 1:1 `*Params`/`*Options` interfaces per Rules 1.3, 1.6, and 3.3, pure `index.ts` barrels, strict acyclic DAG imports, complete `/** ... */` JSDoc on every declaration per Rules 2.1–2.3, and zero inline/non-JSDoc comments per Rule 2.4. Orchestrators only sequence high-level phase calls and lifecycle boundaries (`try / finally`), delegating context extraction, state initialization, validation predicates, and projection steps to focused `internal/` functions. Builders are free and expected to extract additional focused `internal/` phase, predicate, and projection helper files beyond the baseline §3 tables whenever responsibilities separate, while preserving all planned public exports.

### 3.0 Workspace Manifests (`pnpm-workspace.yaml` & `packages/*/{package.json,tsconfig.json}`) & `@paraharness/lockfile` (`packages/lockfile/src/**`)

| File Path | Primary Category | Specification |
| :--- | :--- | :--- |
| `pnpm-workspace.yaml` | `workspace` | `packages: ['packages/*']` (zero `#` comments per `CLAUDE.MD`) |
| `packages/<pkg>/package.json` *(all 16 packages)* | `manifest` | `"name": "@paraharness/<pkg>"`, `"version": "0.1.0"`, `"private": true`, `"type": "module"`, `"exports": { ".": "./src/index.ts" }` (plus `"./runtime": "./src/runtime/index.ts"` on `@paraharness/core`), `"main": "./src/index.ts"`, `"types": "./src/index.ts"`, `"scripts": { "lint": "eslint \"{src,test}/**/*.ts\"", "typecheck": "tsc --noEmit", "test": "vitest run --config ../../vitest.config.ts --dir . --passWithNoTests" }`, and exact `"dependencies"` / `"devDependencies"` per §4.0 |
| `packages/<pkg>/tsconfig.json` *(all 16 packages)* | `tsconfig` | `{ "extends": "../../tsconfig.base.json", "compilerOptions": { "noEmit": true }, "include": ["src/**/*.ts", "test/**/*.ts"] }` |
| `packages/lockfile/src/file-lock.constants.ts` | `const` | `DEFAULT_LOCK_TIMEOUT_MS`, `DEFAULT_LOCK_STALE_MS`, `DEFAULT_LOCK_HEARTBEAT_INTERVAL_MS`, `DEFAULT_LOCK_RETRY_DELAY_MS`, `LOCK_PATH_QUEUES` |
| `packages/lockfile/src/file-lock-options.ts` | `interface` | `FileLockOptions` |
| `packages/lockfile/src/file-lock-lease.ts` | `interface` | `FileLockLease` |
| `packages/lockfile/src/internal/file-lock-record.ts` | `interface` | `FileLockRecord` |
| `packages/lockfile/src/internal/resolved-file-lock-options.ts` | `interface` | `ResolvedFileLockOptions` |
| `packages/lockfile/src/internal/create-heartbeat-lease-params.ts` | `interface` | `CreateHeartbeatLeaseParams` |
| `packages/lockfile/src/internal/stale-lock-helpers.ts` | `function` | `isProcessAlive`, `readLockRecord`, `isExistingLockStale`, `tryReclaimStaleLock` |
| `packages/lockfile/src/internal/disk-lock-lifecycle.ts` | `function` | `resolveFileLockOptions`, `getOrCreateLockQueue`, `acquireDiskFileLock`, `createHeartbeatLease` |
| `packages/lockfile/src/acquire-file-lock.ts` | `function` | `acquireFileLock(lockPath: string, options?: FileLockOptions): Promise<FileLockLease>` |
| `packages/lockfile/src/with-file-lock.ts` | `function` | `withFileLock<T>(lockPath: string, work: () => Promise<T>, options?: FileLockOptions): Promise<T>` |
| `packages/lockfile/src/index.ts` | `barrel` | Pure explicit re-exports of `acquireFileLock`, `FileLockLease`, `FileLockOptions`, and `withFileLock` |

### 3.1 AST Layer (`packages/core/src/ast/**`)

| File Path | Primary Category | Exported Symbols |
| :--- | :--- | :--- |
| `src/ast/ast-node.ts` | `interface` | `ASTNode` |
| `src/ast/ast-builder.ts` | `interface` | `AstBuilder<TNode>` |
| `src/ast/ast-foundation.types.ts` | `type` | `MaybeBuilder<TNode>`, `SourceValue<T>`, `MaybeSource<T>`, `ScopeCapabilityTier` |
| `src/ast/extract-ast.ts` | `function` | `extractAST<TNode extends ASTNode>(input: MaybeBuilder<TNode>): TNode` |
| `src/ast/env-ref.ts` | `interface` | `EnvRef` |
| `src/ast/signal-node.ts` | `interface` | `SignalNode<TPayload>` |
| `src/ast/signal-builder.ts` | `interface` | `SignalBuilder<TPayload>` |
| `src/ast/interrupt-node.ts` | `interface` | `InterruptNode<TPayload>` |
| `src/ast/interrupt-builder.ts` | `interface` | `InterruptBuilder<TPayload>` |
| `src/ast/cross-verifier-builder.ts` | `interface` | `CrossVerifierBuilder<THandle, TReceipt, TCrossReport, TNode>` |
| `src/ast/topology-builder.ts` | `interface` | `TopologyBuilder<TPartition>` |
| `src/ast/stream-node.ts` | `interface` | `StreamNode<TEvent, TPayload>` |
| `src/ast/pool-candidate-state.ts` | `interface` | `PoolCandidateState<TItem>` |
| `src/ast/pool-selection-context.ts` | `interface` | `PoolSelectionContext` |
| `src/ast/standard-pool-strategy-node.ts` | `interface` | `StandardPoolStrategyNode` |
| `src/ast/escalate-on-retry-pool-strategy-node.ts` | `interface` | `EscalateOnRetryPoolStrategyNode` |
| `src/ast/custom-pool-strategy-node.ts` | `interface` | `CustomPoolStrategyNode<TItem>` |
| `src/ast/pool-strategy.types.ts` | `type` | `PoolSelectorFn<TItem>`, `PoolStrategyNode<TItem>` |
| `src/ast/pool-node.ts` | `interface` | `PoolNode<TItem>` |
| `src/ast/prefix-group-node.ts` | `interface` | `PrefixGroupNode` |
| `src/ast/topology-node.ts` | `interface` | `TopologyNode<TPartition>` (plus `TSPropertySignature` sub-interfaces `TopologyPartitionConstraint<TPartition>`, `TopologyCommitOverlayConfig`, `TopologySignalCorrelation<TSig>`) |
| `src/ast/inline-scoped-rule-node.ts` | `interface` | `InlineScopedRuleNode` |
| `src/ast/sourced-scoped-rule-node.ts` | `interface` | `SourcedScopedRuleNode` |
| `src/ast/scoped-rule-node.types.ts` | `type` | `ScopedRuleNode` |
| `src/ast/rules-node.ts` | `interface` | `RulesNode` |
| `src/ast/inline-skill-node.ts` | `interface` | `InlineSkillNode<THandle>` |
| `src/ast/sourced-skill-node.ts` | `interface` | `SourcedSkillNode<THandle>` |
| `src/ast/skill-node.types.ts` | `type` | `SkillNode<THandle>` |
| `src/ast/lessons-node.ts` | `interface` | `LessonsNode<TIn>` (plus `TSPropertySignature` sub-interfaces `LessonDistillationConfig`, `LessonScoringConfig`, `LessonRetirementConfig`, `LessonEmitSignalTrigger`) |
| `src/ast/policy-violation.ts` | `interface` | `PolicyViolation` |
| `src/ast/deny-with-error-policy-guard-clause-node.ts` | `interface` | `DenyWithErrorPolicyGuardClauseNode` |
| `src/ast/raise-interrupt-policy-guard-clause-node.ts` | `interface` | `RaiseInterruptPolicyGuardClauseNode<TPayload>` |
| `src/ast/policy-guard-clause-node.types.ts` | `type` | `PolicyGuardClauseNode` |
| `src/ast/policy-node.ts` | `interface` | `PolicyNode<THandle>` (plus `TSPropertySignature` sub-interface `PolicyLimitExceededConfig<THandle>`) |
| `src/ast/human-node.ts` | `interface` | `HumanNode<TMode>` |
| `src/ast/scoped-human-target-node.ts` | `interface` | `ScopedHumanTargetNode<TResponse>` |
| `src/ast/compaction-config-node.ts` | `interface` | `CompactionConfigNode` (plus `TSPropertySignature` sub-interfaces `CompactionSignalTrigger`, `CompactionTerminalExitTrigger`) |
| `src/ast/command-node.ts` | `interface` | `CommandNode<TIn, TOut, THandle>` |
| `src/ast/fork-capability-node.ts` | `interface` | `ForkCapabilityNode<TParentIn, TReq, TChildIn, TChildOut, THandle>` (plus `TSPropertySignature` sub-interface `ForkModelRoutingConfig<TParentIn, TReq>`) |
| `src/ast/speculate-arbiter-decision.types.ts` | `type` | `SpeculateArbiterDecision` |
| `src/ast/speculate-capability-node.ts` | `interface` | `SpeculateCapabilityNode<TParentIn, TReq, TChildIn, TChildOut, THandle, TCrossReport, TVerdict>` (plus `TSPropertySignature` sub-interfaces `SpeculateArbiterConfig<THandle, TVerdict>`, `SpeculateVerifyWinnerConfig<TChildIn, TChildOut, THandle>`, `SpeculateRefineWinnerConfig<TParentIn, TChildIn, TChildOut, THandle, TVerdict>`) |
| `src/ast/mutate-plan-capability-node.ts` | `interface` | `MutatePlanCapabilityNode<TItem>` (plus `TSPropertySignature` sub-interface `SpawnTasksConfig<TItem>`) |
| `src/ast/escalate-capability-node.ts` | `interface` | `EscalateCapabilityNode<TPayload, TResponse>` (plus `TSPropertySignature` sub-interface `EscalateLeaseElevationConfig<TResponse>`) |
| `src/ast/agent-capabilities-node.ts` | `interface` | `AgentCapabilitiesNode<TParentIn, THandle>` |
| `src/ast/child-interrupt-handler-node.ts` | `interface` | `ChildInterruptHandlerNode<TPayload>` |
| `src/ast/adjudicate-interrupt-handler-node.ts` | `interface` | `AdjudicateInterruptHandlerNode<TIn, TPayload, THandle>` |
| `src/ast/ask-interrupt-handler-node.ts` | `interface` | `AskInterruptHandlerNode<TPayload>` |
| `src/ast/replace-interrupt-handler-node.ts` | `interface` | `ReplaceInterruptHandlerNode<TIn, TPayload, THandle>` |
| `src/ast/interrupt-handler-node.types.ts` | `type` | `InterruptHandlerNode<TIn, TPayload, THandle>` |
| `src/ast/agent-node.ts` | `interface` | `AgentNode<TIn, TOut, THandle>` (plus `TSPropertySignature` sub-interface `AgentLessonsMount`) |
| `src/ast/loop-node.ts` | `interface` | `LoopNode<TIn, TOut, THandle, TActStepId>` (plus `TSPropertySignature` sub-interfaces `LoopActStepConfig<TIn, TOut, THandle, TActStepId>`, `LoopEvaluateStepConfig<TIn, TOut, THandle>`) |
| `src/ast/flow-step-node.ts` | `interface` | `FlowStepNode<TIn, TOut, THandle, TStepId>` |
| `src/ast/flow-branch-node.ts` | `interface` | `FlowBranchNode<TFlowIn, TBranchOut, THandle, TBranchId>` (plus `TSPropertySignature` sub-interface `FlowBranchCase<TFlowIn, THandle>`) |
| `src/ast/flow-node.ts` | `interface` | `FlowNode<TIn, THandle, TStepIds>` |
| `src/ast/lane-node.ts` | `interface` | `LaneNode<TIn, TStepIds>` (plus `TSPropertySignature` sub-interfaces `LaneTrackerConfig<TIn>`, `LaneWaitForConfig<TIn>`, `LaneMaxCostConfig`, `LaneRetryConfig`, `LaneSignalHandlerConfig<TIn, TStepIds>`) |
| `src/ast/harness-node.ts` | `interface` | `HarnessNode` (plus `TSPropertySignature` sub-interface `HarnessSignalNotification`) |
| `src/ast/base/base-isolation-scope-ast-node.ts` | `interface` | `BaseIsolationScopeASTNode<TType, THandle, TReceipt, TSync, TTier>` |
| `src/ast/base/base-domain-step-ast-node.ts` | `interface` | `BaseDomainStepASTNode<TType, TIn, TOut, THandle>` |
| `src/ast/base/base-tool-ast-node.ts` | `interface` | `BaseToolASTNode<TType, TTracking, THandle>` |
| `src/ast/base/base-check-ast-node.ts` | `interface` | `BaseCheckASTNode<TType, THandle>` |
| `src/ast/base/base-service-ast-node.ts` | `interface` | `BaseServiceASTNode<TType, THandle>` (plus `TSPropertySignature` sub-interface `ServiceToolSchemaDescriptor`) |
| `src/ast/base/base-policy-guard-ast-node.ts` | `interface` | `BasePolicyGuardASTNode<TType>` |
| `src/ast/base/base-quota-tripwire-ast-node.ts` | `interface` | `BaseQuotaTripwireASTNode<TType>` |
| `src/ast/base/base-telemetry-collector-ast-node.ts` | `interface` | `BaseTelemetryCollectorASTNode<TType, TMetrics>` |
| `src/ast/base/base-abort-hook-ast-node.ts` | `interface` | `BaseAbortHookASTNode<TType, THandle, TAbortMeta>` |
| `src/ast/base/base-scope-rewind-hook-ast-node.ts` | `interface` | `BaseScopeRewindHookASTNode<TType, THandle>` |
| `src/ast/base/base-cross-verifier-ast-node.ts` | `interface` | `BaseCrossVerifierASTNode<TType, THandle, TReceipt, TCrossReport>` |
| `src/ast/base/base-effect-matcher-ast-node.ts` | `interface` | `BaseEffectMatcherASTNode<TType>` |
| `src/ast/base/base-source-ast-node.ts` | `interface` | `BaseSourceASTNode<TType, T>` |
| `src/ast/base/base-account-seat-ast-node.ts` | `interface` | `BaseAccountSeatASTNode<TType>` |
| `src/ast/base/base-model-ast-node.ts` | `interface` | `BaseModelASTNode<TType, TSeat>` |
| `src/ast/base/base-ledger-store-ast-node.ts` | `interface` | `BaseLedgerStoreASTNode<TType>` |
| `src/ast/base/base-topology-store-ast-node.ts` | `interface` | `BaseTopologyStoreASTNode<TType>` |
| `src/ast/base/base-lesson-store-ast-node.ts` | `interface` | `BaseLessonStoreASTNode<TType>` |
| `src/ast/base/base-tracker-ast-node.ts` | `interface` | `BaseTrackerASTNode<TType, TExternal, TExternalState>` |
| `src/ast/base/base-stream-source-ast-node.ts` | `interface` | `BaseStreamSourceASTNode<TType, TEvent>` |
| `src/ast/base/base-human-channel-ast-node.ts` | `interface` | `BaseHumanChannelASTNode<TType, TMode>` |
| `src/ast/base/base-control-plane-ast-node.ts` | `interface` | `BaseControlPlaneASTNode<TType>` |
| `src/ast/base/base-runner-pool-ast-node.ts` | `interface` | `BaseRunnerPoolASTNode<TType>` |
| `src/ast/custom-domain-ast-registry.ts` | `interface` | `CustomDomainASTRegistry` |
| `src/ast/domain/claude-account-seat-node.ts` | `interface` | `ClaudeAccountSeatNode` |
| `src/ast/domain/claude-model-node.ts` | `interface` | `ClaudeModelNode` |
| `src/ast/domain/openai-account-seat-node.ts` | `interface` | `OpenAiAccountSeatNode` |
| `src/ast/domain/openai-model-node.ts` | `interface` | `OpenAiModelNode` |
| `src/ast/domain/gemini-account-seat-node.ts` | `interface` | `GeminiAccountSeatNode` |
| `src/ast/domain/gemini-model-node.ts` | `interface` | `GeminiModelNode` |
| `src/ast/domain/node-runner-node.ts` | `interface` | `NodeRunnerNode` |
| `src/ast/domain/local-command-node.ts` | `interface` | `LocalCommandNode<TIn, TOut, THandle>` (plus `TSPropertySignature` sub-interface `LocalCommandUnrepeatableConfig`) |
| `src/ast/domain/local-command-check-node.ts` | `interface` | `LocalCommandCheckNode<THandle>` |
| `src/ast/domain/local-command-tool-node.ts` | `interface` | `LocalCommandToolNode<THandle>` |
| `src/ast/domain/local-stream-check-node.ts` | `interface` | `LocalStreamCheckNode<THandle>` (plus `TSPropertySignature` sub-interface `LocalStreamCheckCircuitBreakerConfig`) |
| `src/ast/domain/local-stream-check-tool-node.ts` | `interface` | `LocalStreamCheckToolNode<THandle>` |
| `src/ast/domain/local-service-node.ts` | `interface` | `LocalServiceNode` (plus `TSPropertySignature` sub-interface `LocalServiceInteractionConfig`) |
| `src/ast/domain/local-service-tool-node.ts` | `interface` | `LocalServiceToolNode<THandle>` |
| `src/ast/domain/node-allow-binaries-node.ts` | `interface` | `NodeAllowBinariesNode` |
| `src/ast/domain/node-deny-network-node.ts` | `interface` | `NodeDenyNetworkNode` |
| `src/ast/domain/node-http-control-plane-node.ts` | `interface` | `NodeHttpControlPlaneNode` |
| `src/ast/domain/node-mcp-stdio-node.ts` | `interface` | `NodeMcpStdioNode` |
| `src/ast/domain/node-mcp-sse-node.ts` | `interface` | `NodeMcpSseNode` |
| `src/ast/domain/fs-read-tool-node.ts` | `interface` | `FsReadToolNode<THandle>` |
| `src/ast/domain/fs-edit-tool-node.ts` | `interface` | `FsEditToolNode<THandle>` |
| `src/ast/domain/fs-write-tool-node.ts` | `interface` | `FsWriteToolNode<THandle>` |
| `src/ast/domain/fs-glob-tool-node.ts` | `interface` | `FsGlobToolNode<THandle>` |
| `src/ast/domain/fs-grep-tool-node.ts` | `interface` | `FsGrepToolNode<THandle>` |
| `src/ast/domain/fs-text-source-node.ts` | `interface` | `FsTextSourceNode` |
| `src/ast/domain/fs-glob-source-node.ts` | `interface` | `FsGlobSourceNode` |
| `src/ast/domain/fs-glob-matcher-node.ts` | `interface` | `FsGlobMatcherNode` |
| `src/ast/domain/fs-partition-map-node.ts` | `interface` | `FsPartitionMapNode<TPartition>` (plus `TSPropertySignature` sub-interface `FsPartitionPathMapping`) |
| `src/ast/domain/fs-boundary-guard-node.ts` | `interface` | `FsBoundaryGuardNode` |
| `src/ast/domain/fs-write-guard-node.ts` | `interface` | `FsWriteGuardNode` |
| `src/ast/domain/fs-protect-guard-node.ts` | `interface` | `FsProtectGuardNode` |
| `src/ast/domain/fs-read-only-guard-node.ts` | `interface` | `FsReadOnlyGuardNode` |
| `src/ast/domain/fs-allow-only-guard-node.ts` | `interface` | `FsAllowOnlyGuardNode` |
| `src/ast/domain/fs-require-read-before-write-guard-node.ts` | `interface` | `FsRequireReadBeforeWriteGuardNode` |
| `src/ast/domain/fs-scoped-write-guard-node.ts` | `interface` | `FsScopedWriteGuardNode` |
| `src/ast/domain/fs-secret-literals-guard-node.ts` | `interface` | `FsSecretLiteralsGuardNode` |
| `src/ast/domain/fs-quota-tripwire-node.ts` | `interface` | `FsQuotaTripwireNode` |
| `src/ast/domain/fs-telemetry-collector-node.ts` | `interface` | `FsTelemetryCollectorNode` |
| `src/ast/domain/fs-regex-check-node.ts` | `interface` | `FsRegexCheckNode<THandle>` |
| `src/ast/domain/fs-jsonl-lesson-store-node.ts` | `interface` | `FsJsonlLessonStoreNode` |
| `src/ast/domain/git-worktree-handle.ts` | `interface` | `GitWorktreeHandle` |
| `src/ast/domain/git-scope-receipt.ts` | `interface` | `GitScopeReceipt` |
| `src/ast/domain/git-sync-receipt.ts` | `interface` | `GitSyncReceipt` |
| `src/ast/domain/git-abort-meta.ts` | `interface` | `GitAbortMeta` |
| `src/ast/domain/git-clean-working-tree-node.ts` | `interface` | `GitCleanWorkingTreeNode` |
| `src/ast/domain/git-cow-worktree-node.ts` | `interface` | `GitCowWorktreeNode<THandle, TReceipt, TSync>` (plus `TSPropertySignature` sub-interface `GitReconcileStrategyConfig<THandle>`) |
| `src/ast/domain/git-commit-and-push-node.ts` | `interface` | `GitCommitAndPushNode<TIn>` |
| `src/ast/domain/git-merge-queue-node.ts` | `interface` | `GitMergeQueueNode<TIn, TOut>` |
| `src/ast/domain/git-snapshot-and-reset-node.ts` | `interface` | `GitSnapshotAndResetNode` |
| `src/ast/domain/git-keep-worktree-node.ts` | `interface` | `GitKeepWorktreeNode` |
| `src/ast/domain/git-discard-branch-node.ts` | `interface` | `GitDiscardBranchNode` |
| `src/ast/domain/git-patch-equivalence-node.ts` | `interface` | `GitPatchEquivalenceNode<TCrossReport>` |
| `src/ast/domain/git-public-surface-cross-tester-node.ts` | `interface` | `GitPublicSurfaceCrossTesterNode<TCrossReport>` |
| `src/ast/domain/git-ref-reader-tool-node.ts` | `interface` | `GitRefReaderToolNode<THandle>` |
| `src/ast/domain/git-candidate-comparison-tool-node.ts` | `interface` | `GitCandidateComparisonToolNode<THandle>` |
| `src/ast/domain/markdown-frontmatter-source-node.ts` | `interface` | `MarkdownFrontmatterSourceNode<T>` (including `readonly kind?: 'global-rules' \| 'scoped-rule' \| 'scoped-rules' \| 'skill' \| 'skills' \| 'frontmatter'`) |
| `src/ast/domain/markdown-section-source-node.ts` | `interface` | `MarkdownSectionSourceNode<T>` |
| `src/ast/domain/sqlite-ledger-node.ts` | `interface` | `SqliteLedgerNode` |
| `src/ast/domain/postgres-ledger-node.ts` | `interface` | `PostgresLedgerNode` |
| `src/ast/domain/sqlite-topology-node.ts` | `interface` | `SqliteTopologyNode` |
| `src/ast/domain/postgres-topology-node.ts` | `interface` | `PostgresTopologyNode` |
| `src/ast/domain/sqlite-lessons-node.ts` | `interface` | `SqliteLessonsNode` |
| `src/ast/domain/postgres-lessons-node.ts` | `interface` | `PostgresLessonsNode` |
| `src/ast/domain/sqlite-rules-source-node.ts` | `interface` | `SqliteRulesSourceNode` |
| `src/ast/domain/postgres-rules-source-node.ts` | `interface` | `PostgresRulesSourceNode` |
| `src/ast/domain/github-issues-tracker-node.ts` | `interface` | `GithubIssuesTrackerNode<TExternal, TExternalState>` |
| `src/ast/domain/github-webhook-stream-node.ts` | `interface` | `GithubWebhookStreamNode<TEvent>` |
| `src/ast/domain/github-create-or-update-pr-node.ts` | `interface` | `GithubCreateOrUpdatePrNode<TIn, TOut, THandle>` |
| `src/ast/domain/slack-approver-node.ts` | `interface` | `SlackApproverNode` |
| `src/ast/domain/slack-notifier-node.ts` | `interface` | `SlackNotifierNode` |
| `src/ast/domain-ast.types.ts` | `type` | `BaseStepASTNode<TType, TIn, TOut, THandle>`, `CustomDomainAST<K>` (resolving both exact key `K` and namespaced `${K}:${string}` keys), `IsolationScopeASTNode`, `DomainStepASTNode`, `StepASTNode`, `BuiltInToolASTNode`, `ToolASTNode`, `BuiltInCheckASTNode`, `CheckASTNode`, `EvaluatorASTNode`, `ServiceASTNode`, `BuiltInGuardASTNode`, `GuardASTNode`, `PolicyGuardASTNode`, `QuotaTripwireASTNode`, `TelemetryCollectorASTNode`, `AbortHookASTNode`, `ScopeRewindHookASTNode`, `PatchEquivalenceASTNode`, `CrossTesterASTNode`, `CrossVerifierASTNode`, `SourceASTNode`, `AccountSeatASTNode`, `ModelASTNode`, `LedgerStoreASTNode`, `TopologyStoreASTNode`, `LessonStoreASTNode`, `TrackerASTNode`, `StreamSourceASTNode`, `HumanChannelASTNode`, `ControlPlaneASTNode`, `EffectMatcherASTNode`, `RunnerPoolASTNode`, `DomainASTNode`, `CoreASTNode` |

### 3.2 Ports Layer (`packages/core/src/ports/**`)

| File Path | Primary Category | Exported Symbols |
| :--- | :--- | :--- |
| `src/ports/node-executor.types.ts` | `type` | `NodeExecutor<TNode, TInput, TOutput, TContext>`, `NodeExecutorMap<TUnion, TInput, TOutput, TContext>` |
| `src/ports/runtime-driver-context.ts` | `interface` | `RuntimeDriverContext` |
| `src/ports/execution-context.ts` | `interface` | `ExecutionContext<THandle>` |
| `src/ports/step-execution-context.ts` | `interface` | `StepExecutionContext<THandle>` |
| `src/ports/runtime-executor-registry.ts` | `interface` | `RuntimeExecutorRegistry` |
| `src/ports/runtime-executor-registry-slice.ts` | `interface` | `RuntimeExecutorRegistrySlice` |
| `src/ports/create-executor-registry.ts` | `function` | `createExecutorRegistry(...slices: ReadonlyArray<RuntimeExecutorRegistrySlice \| readonly RuntimeExecutorRegistrySlice[]>): RuntimeExecutorRegistry` |
| `src/ports/harness-runtime.ts` | `interface` | `HarnessRuntime` |
| `src/ports/harness-execution-engine.ts` | `interface` | `HarnessExecutionEngine` (plus `TSMethodSignature` sub-interface `HarnessRuntimeOptions`) |
| `src/ports/harness-runtime-controller.ts` | `interface` | `HarnessRuntimeController` (with `emitSignal<TPayload = unknown>(signal: MaybeBuilder<SignalNode<TPayload>> \| string, payload: TPayload, filter?: { laneId?: string; runId?: string }): Promise<void>`) |
| `src/ports/resolution-context.ts` | `interface` | `ResolutionContext` |
| `src/ports/tool-effect.ts` | `interface` | `ToolEffect` |
| `src/ports/lease-delta.ts` | `interface` | `LeaseDelta` |
| `src/ports/runner-driver.ts` | `interface` | `RunnerDriver` |
| `src/ports/tool-driver.ts` | `interface` | `ToolDriver<TNode, THandle>` (plus `TSMethodSignature` sub-interface `ToolExecutionResult`) |
| `src/ports/service-session.ts` | `interface` | `ServiceSession<THandle>` |
| `src/ports/reconcile-clean-result.ts` | `interface` | `ReconcileCleanResult<TData>` |
| `src/ports/reconcile-conflict-result.ts` | `interface` | `ReconcileConflictResult<TData>` |
| `src/ports/reconcile-result.types.ts` | `type` | `ReconcileResult<TData>` |
| `src/ports/isolation-scope.ts` | `interface` | `IsolationScope<THandle, TReceipt>` |
| `src/ports/checkpointable-scope.ts` | `interface` | `CheckpointableScope<THandle, TReceipt>` |
| `src/ports/branchable-scope.ts` | `interface` | `BranchableScope<THandle, TReceipt, TSync>` |
| `src/ports/canonical-message.ts` | `interface` | `CanonicalMessage` (plus `TSPropertySignature` sub-interfaces `CanonicalToolCall`, `CanonicalToolResult`) |
| `src/ports/wire-frame-record.ts` | `interface` | `WireFrameRecord` |
| `src/ports/compiled-wire-prefix.ts` | `interface` | `CompiledWirePrefix` (plus `TSPropertySignature` sub-interfaces `WireToolSchema`, `GroundingSnapshotRecord`) |
| `src/ports/fork-context.ts` | `interface` | `ForkContext` (plus `TSPropertySignature` sub-interface `PrecedingCompletedToolResult`) |
| `src/ports/model-driver.ts` | `interface` | `ModelDriver` (plus `TSMethodSignature` / `TSPropertySignature` sub-interfaces `ModelTurnRequest`, `ModelTurnResponse`, `ModelUsageMetrics`, `PrepareForkTarget`, `AppendToolResultNotesOptions`) |
| `src/ports/universal-step-telemetry.ts` | `interface` | `UniversalStepTelemetry<TCustomMetrics, TAbortMeta>` |
| `src/ports/pending-tool-batch.ts` | `interface` | `PendingToolBatch` (plus `TSPropertySignature` sub-interfaces `PendingPreFlightCall`, `RemainingToolCallRecord`) |
| `src/ports/active-turn-pause-state.ts` | `interface` | `ActiveTurnPauseState` |
| `src/ports/tool-batch-pause-state.ts` | `interface` | `ToolBatchPauseState` |
| `src/ports/before-stop-gate-pause-state.ts` | `interface` | `BeforeStopGatePauseState` |
| `src/ports/adjudication-pause-state.ts` | `interface` | `AdjudicationPauseState` (plus `TSPropertySignature` sub-interface `PendingAdjudicationRecord`) |
| `src/ports/prerequisite-wait-pause-state.ts` | `interface` | `PrerequisiteWaitPauseState` |
| `src/ports/interrupt-flush-pause-state.ts` | `interface` | `InterruptFlushPauseState` |
| `src/ports/agent-pause-state.types.ts` | `type` | `AgentPauseState` |
| `src/ports/agent-continuation-frame.ts` | `interface` | `AgentContinuationFrame` |
| `src/ports/loop-continuation-frame.ts` | `interface` | `LoopContinuationFrame` |
| `src/ports/fork-batch-continuation-frame.ts` | `interface` | `ForkBatchContinuationFrame` (plus `TSPropertySignature` sub-interfaces `ForkBatchEntryRecord`, `PendingPauseTriggerRecord`) |
| `src/ports/speculate-continuation-frame.ts` | `interface` | `SpeculateContinuationFrame` (plus `TSPropertySignature` sub-interfaces `SpeculateBranchEntryRecord`, `SpeculateHumanRulingRecord`, `SpeculateBufferedLessonOutcomeRecord`) |
| `src/ports/continuation-frame.types.ts` | `type` | `ContinuationFrame` |
| `src/ports/suspended-fork-record.ts` | `interface` | `SuspendedForkRecord` |
| `src/ports/ledger-store.ts` | `interface` | `LedgerStore` (plus `TSMethodSignature` sub-interfaces `CreateOrResumeRunInput`, `CreateOrResumeRunResult`, `RecordStepStartInput`, `MutateLanePlanRequest`, `RecordStepTransitionInput`, `InterruptedStepBootRecord`) |
| `src/ports/topology-partition-state.ts` | `interface` | `TopologyPartitionState` |
| `src/ports/topology-store.ts` | `interface` | `TopologyStore` (plus `TSMethodSignature` sub-interface `CommitRunOverlayResult`) |
| `src/ports/lesson-outcome.types.ts` | `type` | `LessonOutcome` |
| `src/ports/distilled-lesson-candidate.ts` | `interface` | `DistilledLessonCandidate` |
| `src/ports/lesson-record.ts` | `interface` | `LessonRecord` |
| `src/ports/lesson-store.ts` | `interface` | `LessonStore` |
| `src/ports/tracker-adapter.ts` | `interface` | `TrackerAdapter<TExternal, TExternalState>` |
| `src/ports/stream-source.ts` | `interface` | `StreamSource<TEvent>` |
| `src/ports/human-adapter.ts` | `interface` | `HumanAdapter` (plus `TSMethodSignature` sub-interface `HumanDecisionRequest<TRequest, TResponse>`) |
| `src/ports/control-plane-adapter.ts` | `interface` | `ControlPlaneAdapter` |

### 3.3 Schemas & Topology Layers (`packages/core/src/schemas/**`, `packages/core/src/topology/**`)

| File Path | Primary Category | Exported Symbols |
| :--- | :--- | :--- |
| `src/schemas/core-rules.schema.ts` | `schema` | `ScopePredicateSchema`, `ScopePredicate`, `GlobalRuleSchema`, `GlobalRule`, `ScopedRuleSchema`, `ScopedRule` |
| `src/schemas/budget-and-lesson.schema.ts` | `schema` | `BudgetApprovalSchema`, `BudgetApproval`, `DistilledLessonCandidateSchema`, `ResumeForkInputSchema`, `ResumeForkInput` |
| `src/schemas/speculation-schemas.ts` | `function` | `SpeculationCandidateSchema`, `SpeculationInputSchema` |
| `src/schemas/zod-to-json-schema.ts` | `function` | `zodToJsonSchema(schema: z.ZodTypeAny): Readonly<Record<string, unknown>>` (delegating to Zod v4 `z.toJSONSchema()`) |
| `src/topology/internal/validate-topology-dag.ts` | `function` | `validateTopologyDAG`, `computeTransitiveDependents` (backed by `@dagrejs/graphlib` `Graph`, `alg.findCycles`, `alg.preorder`) |
| `src/topology/topology-queries.ts` | `function` | `dependentsOf<TPartition extends string>(topology: MaybeBuilder<TopologyNode<TPartition>>, partitionId: TPartition): readonly TPartition[]`, `affectedBy<TPartition extends string>(topology: MaybeBuilder<TopologyNode<TPartition>>, partitionId: TPartition): readonly TPartition[]` |

### 3.4 Fluent Builders Layer & `P` Namespace (`packages/core/src/builders/**`, `packages/core/src/p-namespace*`)

| File Path | Primary Category | Exported Symbols |
| :--- | :--- | :--- |
| `src/builders/builder-defaults.constants.ts` | `const` | `DEFAULT_AGENT_MAX_TURNS`, `DEFAULT_LESSON_TOP_K`, `DEFAULT_LESSON_MIN_SCORE`, `DEFAULT_LESSON_WEIGHTS`, `DEFAULT_NODE_RUNNER_AST_NODE` |
| `src/builders/internal/deep-freeze.ts` | `function` | `deepFreeze<T>(value: T): Readonly<T>`, `assertNonEmptyIdentifier(label: string, id: string): void`, `deriveCanonicalRoleKey(baseId: string, extraTools: readonly ToolASTNode<any>[]): string` |
| `src/builders/internal/validate-flow-capabilities.ts` | `function` | `validateFlowScopeCapabilities`, `validatePrefixGroupCloneTranscriptMode`, `validateBidirectionalHumanChannel` |
| `src/builders/create-signal-builder.ts` | `function` | `createSignalBuilder` |
| `src/builders/create-interrupt-builder.ts` | `function` | `createInterruptBuilder` |
| `src/builders/stream-builder.ts` | `interface` | `StreamBuilder<TEvent, TPayload>` |
| `src/builders/create-stream-builder.ts` | `function` | `createStreamBuilder` |
| `src/builders/pool-builder.ts` | `interface` | `PoolBuilder<TItem>` (plus `TSMethodSignature` sub-interface `PoolStrategyConfigurator<TItem>`) |
| `src/builders/create-pool-builder.ts` | `function` | `createPoolBuilder` |
| `src/builders/prefix-group-builder.ts` | `interface` | `PrefixGroupBuilder` |
| `src/builders/create-prefix-group-builder.ts` | `function` | `createPrefixGroupBuilder` |
| `src/builders/create-topology-builder.ts` | `function` | `createTopologyBuilder` |
| `src/builders/human-builder.ts` | `interface` | `HumanBuilder<TMode>` (plus `TSMethodSignature` sub-interface `ScopedHumanTargetBuilder<TResponse>`) |
| `src/builders/create-human-builder.ts` | `function` | `createHumanBuilder` |
| `src/builders/rules-builder.ts` | `interface` | `RulesBuilder` |
| `src/builders/create-rules-builder.ts` | `function` | `createRulesBuilder` |
| `src/builders/scoped-rule-builder.ts` | `interface` | `ScopedRuleBuilder` |
| `src/builders/create-scoped-rule-builder.ts` | `function` | `createScopedRuleBuilder` |
| `src/builders/skill-builder.ts` | `interface` | `SkillBuilder<THandle>` |
| `src/builders/create-skill-builder.ts` | `function` | `createSkillBuilder` |
| `src/builders/lessons-builder.ts` | `interface` | `LessonsBuilder<TIn>` (plus `TSMethodSignature` sub-interfaces `LessonDistillationBuilder`, `LessonScoringBuilder`, `LessonRetirementBuilder`, `LessonSignalTriggerBuilder`) |
| `src/builders/create-lessons-builder.ts` | `function` | `createLessonsBuilder` |
| `src/builders/policy-builder.ts` | `interface` | `PolicyBuilder<THandle>` (plus `TSMethodSignature` sub-interfaces `PolicyGuardClauseBuilder<THandle>`, `PolicyLimitExceededBuilder<THandle, TPayload>`) |
| `src/builders/create-policy-builder-state.ts` | `interface` | `CreatePolicyBuilderState<THandle>` |
| `src/builders/create-policy-builder.ts` | `function` | `createPolicyBuilder` |
| `src/builders/fork-capability-builder.ts` | `interface` | `ForkCapabilityBuilder<TParentIn, TReq, TChildIn, TChildOut, THandle>` (plus `TSMethodSignature` sub-interface `ForkModelRoutingBuilder<TParentIn, TReq>`) |
| `src/builders/create-fork-capability-builder.ts` | `function` | `createForkCapabilityBuilder` |
| `src/builders/mutate-plan-capability-builder.ts` | `interface` | `MutatePlanCapabilityBuilder<TItem>` |
| `src/builders/create-mutate-plan-capability-builder.ts` | `function` | `createMutatePlanCapabilityBuilder` |
| `src/builders/escalate-capability-builder.ts` | `interface` | `EscalateCapabilityBuilder<TPayload, TResponse>` |
| `src/builders/create-escalate-capability-builder.ts` | `function` | `createEscalateCapabilityBuilder` |
| `src/builders/speculate-capability-builder.ts` | `interface` | `SpeculateCapabilityBuilder<TParentIn, TReq, TChildIn, TChildOut, THandle, TCrossReport, TVerdict>` |
| `src/builders/create-speculate-capability-builder.ts` | `function` | `createSpeculateCapabilityBuilder` |
| `src/builders/agent-capabilities-builder.ts` | `interface` | `AgentCapabilitiesBuilder<TParentIn, THandle>` |
| `src/builders/create-agent-capabilities-builder.ts` | `function` | `createAgentCapabilitiesBuilder` |
| `src/builders/interrupt-edge-builder.ts` | `interface` | `InterruptEdgeBuilder<TIn, TPayload, THandle, TReceipt, TCustomMetrics, TAbortMeta>` (plus `TSMethodSignature` sub-interfaces `AdjudicateInterruptBuilder<TIn, TPayload, THandle, TAdjOut>`, `AskInterruptBuilder<TPayload, TResponse>`) |
| `src/builders/create-interrupt-edge-builder.ts` | `function` | `createInterruptEdgeBuilder` |
| `src/builders/create-child-interrupt-handler-builder.ts` | `function` | `createChildInterruptHandlerBuilder` |
| `src/builders/command-builder.ts` | `interface` | `CommandBuilder<TIn, TOut, THandle>` (plus `TSMethodSignature` sub-interface `CommandConfigOptions<TIn, TOut, THandle>`) |
| `src/builders/create-command-builder.ts` | `function` | `createCommandBuilder` |
| `src/builders/agent-builder.ts` | `interface` | `AgentBuilder<TIn, TOut, THandle>` (plus `TSMethodSignature` sub-interface `ChildInterruptHandlerBuilder<TPayload>`) |
| `src/builders/internal/agent-builder-state.ts` | `interface` | `AgentBuilderState<TIn, TOut, THandle>` |
| `src/builders/create-agent-builder.ts` | `function` | `createAgentBuilder` |
| `src/builders/loop-builder.ts` | `interface` | `LoopBuilder<TIn, TOut, THandle, TActStepId, TReceipt>` (plus `TSMethodSignature` sub-interface `LoopEvaluateOptions<TIn, TOut, THandle, TReceipt, TEvalIn, TEvalOut>`) |
| `src/builders/internal/loop-builder-state.ts` | `interface` | `LoopBuilderState<TIn, TOut, THandle, TActStepId>` |
| `src/builders/create-loop-builder.ts` | `function` | `createLoopBuilder` |
| `src/builders/flow-branch-builder.ts` | `interface` | `FlowBranchBuilder<TFlowIn, TBranchOut, THandle, TBranchId, TReceipt, TCustomMetrics, TStepOutputs>` (plus `TSMethodSignature` sub-interface `FlowSubBranchBuilder<TFlowIn, TBranchOut, THandle, TReceipt, TCustomMetrics, TStepOutputs>`) |
| `src/builders/create-flow-branch-builder.ts` | `function` | `createFlowBranchBuilder` |
| `src/builders/flow-builder.ts` | `interface` | `FlowBuilder<TIn, THandle, TStepIds, TReceipt, TCustomMetrics, TStepOutputs>` (plus `TSMethodSignature` sub-interface `FlowStepConfigBuilder<TFlowIn, TStepIn, TStepOut, THandle, TReceipt, TCustomMetrics, TStepOutputs>`) |
| `src/builders/internal/flow-builder-state.ts` | `interface` | `FlowBuilderState<TIn, THandle, TStepIds>` |
| `src/builders/create-flow-builder.ts` | `function` | `createFlowBuilder` |
| `src/builders/lane-builder.ts` | `interface` | `LaneBuilder<TIn, TStepIds>` (plus `TSMethodSignature` sub-interfaces `LaneTrackerConfigBuilder<TIn, TExternal, TExternalState>`, `LaneRetryConfigBuilder`, `LaneSignalHandlerBuilder<TIn, TStepIds, TPayload>`) |
| `src/builders/internal/lane-builder-state.ts` | `interface` | `LaneBuilderState<TIn, TStepIds>` |
| `src/builders/create-lane-builder.ts` | `function` | `createLaneBuilder` |
| `src/builders/harness-builder.ts` | `interface` | `HarnessBuilder` (plus `TSMethodSignature` sub-interface `HarnessSignalNotificationBuilder<TPayload>`) |
| `src/builders/create-harness-builder.ts` | `function` | `createHarnessBuilder` |
| `src/p-namespace-contract.ts` | `interface` | `PNamespace` |
| `src/p-namespace.ts` | `const` | `P: PNamespace` |
| `src/runtime/index.ts` | `barrel` | Pure explicit re-exports of `createExecutorRegistry` and runtime port types (expanded in `M2`) |
| `src/index.ts` | `barrel` | Pure explicit re-exports of `P`, `PNamespace`, `z`, `extractAST`, `dependentsOf`, `affectedBy`, `zodToJsonSchema`, `createExecutorRegistry`, `DEFAULT_NODE_RUNNER_AST_NODE`, all schemas, all builder interfaces (including all `TSMethodSignature` sub-builder and options interfaces) and factory functions, all port interfaces/types, and all `CoreASTNode` / `DomainASTNode` interfaces/types |

---

## 4. Detailed Implementation Requirements

### 4.0 Workspace Package Manifests, `NodeNext` Exports, Single-Kind File Separation & JSDoc Discipline (`pnpm-workspace.yaml` & `packages/*/{package.json,tsconfig.json}`)
1. **Single-Responsibility Decomposition, Single-Kind Entity Files, Co-Location & JSDoc Discipline (`docs/CODING_GUIDELINES.md` §§1–3)**:
   - Every file, class, method, and function in `src/**` and `test/fixtures/**` must have **one clear responsibility at one uniform level of abstraction** (`docs/CODING_GUIDELINES.md` §§1–3). Orchestrators only sequence high-level phase calls and lifecycle boundaries (`try / finally`), delegating context extraction, state initialization, validation predicates, and outcome projection to focused `internal/` functions. Builders are free and expected to extract additional focused `internal/` phase, predicate, and projection helper files beyond the baseline §3 table whenever responsibilities separate, while preserving all planned public exports.
   - Unrelated or different-kind declarations (`interface`, `function`, `class`, `const`, `type`) must **never** share a file in `src/**` or `test/fixtures/**` (Rules 1.1–1.7):
     - `*.schema.ts` pairs a Zod schema `export const FooSchema = z.object(...)` with its `export type Foo = z.infer<typeof FooSchema>`.
     - Each root `interface` lives in its own `kebab-case` file, and secondary interfaces reachable from that root interface via **`TSPropertySignature`, `TSIndexSignature`, `extends`, or `TSMethodSignature` parameter/return types** (such as fluent callback sub-builders `$d`, `$r`, `$t`, `$f`, `$s`, `$intr`, `$b`, `$c`, `$m`, `$l` and dedicated port method input/output records) are co-located in their parent root interface file (`Rule 1.2`).
     - Dedicated 1:1 `*Params` / `*Options` interfaces (and their reachable sub-interfaces) for a single function or class are co-located in the same file as that function or class (`Rules 1.3, 1.6, 3.3`), while `*State` interfaces and multi-caller shared parameter interfaces live in their own single-interface files.
     - Every builder factory function (`create-*-builder.ts`) gets its own focused file (`Rule 1.6`).
   - Every `class` (and its constructor, methods, and properties), `interface` (and its properties and methods), `function` (public and `internal/`), and top-level `type` alias or `const` in `src/**` and `test/fixtures/**` must carry a complete `/** ... */` JSDoc block per `docs/CODING_GUIDELINES.md` Rules 2.1–2.4 (clear summary sentence, behavioral description when non-obvious, and complete `@template`, `@param {Type} name - Description`, `@returns {Type} Description`, and `@throws` / `@note` / `@example` tags where applicable, with zero inline or body comments), enforced by `pnpm --filter @paraharness/lockfile --filter @paraharness/core lint`.
2. **`pnpm-workspace.yaml`**:
   - Contains `packages: ['packages/*']` with zero `#` comments (`CLAUDE.MD`).
3. **`packages/<pkg>/package.json` for all 16 workspace packages**:
   - Every package manifest includes:
     - `"name": "@paraharness/<pkg>"`, `"version": "0.1.0"`, `"private": true`, `"type": "module"`.
     - `"exports"`: `{ ".": "./src/index.ts" }` on `@paraharness/lockfile` and all adapter/integration packages, and `{ ".": "./src/index.ts", "./runtime": "./src/runtime/index.ts" }` on `@paraharness/core` (required under `moduleResolution: "NodeNext"`).
     - `"main": "./src/index.ts"`, `"types": "./src/index.ts"`.
     - `"scripts"`: `{ "lint": "eslint \"{src,test}/**/*.ts\"", "typecheck": "tsc --noEmit", "test": "vitest run --config ../../vitest.config.ts --dir . --passWithNoTests" }` so `pnpm --filter @paraharness/<pkg> lint`, `typecheck`, and `test` execute cleanly on that package.
     - Base `"devDependencies"`: `{ "@types/node": "^22.9.0", "typescript": "^5.8.2", "vitest": "^3.2.0" }` across all 16 packages, plus package-specific `"dependencies"` and extra `"devDependencies"` (`docs/CODING_GUIDELINES.md` Rule 3.5):
       - `@paraharness/lockfile`: `"dependencies": { "p-queue": "^9.1.0" }`.
       - `@paraharness/core`: `"dependencies": { "@dagrejs/graphlib": "^4.0.7", "diff": "^9.0.0", "p-limit": "^7.3.0", "p-queue": "^9.1.0", "zod": "^4.6.7" }`.
       - `@paraharness/sqlite`: `"dependencies": { "@dagrejs/graphlib": "^4.0.7", "@paraharness/core": "workspace:*", "better-sqlite3": "^12.8.0", "minisearch": "^7.2.0", "node-diff3": "^3.2.1", "p-queue": "^9.1.0", "zod": "^4.6.7" }`; extra `"devDependencies": { "@types/better-sqlite3": "^9.6.0" }`.
       - `@paraharness/postgres`: `"dependencies": { "@dagrejs/graphlib": "^4.0.7", "@electric-sql/pglite": "^0.5.15", "@paraharness/core": "workspace:*", "minisearch": "^7.2.0", "node-diff3": "^3.2.1", "p-queue": "^9.1.0", "pg": "^8.23.1", "zod": "^4.6.7" }`; extra `"devDependencies": { "@types/better-sqlite3": "^9.6.0", "@types/pg": "^8.23.1", "better-sqlite3": "^12.8.0" }`.
       - `@paraharness/fs`: `"dependencies": { "@paraharness/core": "workspace:*", "@paraharness/lockfile": "workspace:*", "minisearch": "^7.2.0", "p-queue": "^9.1.0", "picomatch": "^4.0.3", "tinyglobby": "^0.2.17", "write-file-atomic": "^8.0.0", "zod": "^4.6.7" }`; extra `"devDependencies": { "@types/picomatch": "^4.0.3", "@types/write-file-atomic": "^4.0.3" }`.
       - `@paraharness/markdown`: `"dependencies": { "@paraharness/core": "workspace:*", "mdast-util-frontmatter": "^2.0.1", "mdast-util-from-markdown": "^2.1.0", "mdast-util-to-markdown": "^2.2.3", "micromark-extension-frontmatter": "^2.0.0", "picomatch": "^4.0.3", "tinyglobby": "^0.2.17", "yaml": "^2.9.1", "zod": "^4.6.7" }`; extra `"devDependencies": { "@types/picomatch": "^4.0.3" }`.
       - `@paraharness/node`: `"dependencies": { "@paraharness/core": "workspace:*", "@modelcontextprotocol/sdk": "^1.32.2", "fkill": "^10.0.3", "get-port": "^7.2.0", "node-pty": "^1.1.0", "p-limit": "^7.3.0", "p-queue": "^9.1.0", "pidtree": "^1.0.0", "wait-on": "^9.5.1", "zod": "^4.6.7" }`; extra `"devDependencies": { "@types/wait-on": "^5.3.4" }`.
       - `@paraharness/git`: `"dependencies": { "@paraharness/core": "workspace:*", "@paraharness/lockfile": "workspace:*", "es-module-lexer": "^3.0.4", "p-queue": "^9.1.0", "picomatch": "^4.0.3", "write-file-atomic": "^8.0.0", "zod": "^4.6.7" }`; extra `"devDependencies": { "@types/picomatch": "^4.0.3", "@types/write-file-atomic": "^4.0.3" }`.
       - `@paraharness/claude`: `"dependencies": { "@anthropic-ai/sdk": "^1.6.0", "@paraharness/core": "workspace:*", "zod": "^4.6.7" }`.
       - `@paraharness/openai`: `"dependencies": { "@paraharness/core": "workspace:*", "openai": "^7.53.0", "zod": "^4.6.7" }`.
       - `@paraharness/gemini`: `"dependencies": { "@google/genai": "^3.0.0", "@paraharness/core": "workspace:*", "zod": "^4.6.7" }`.
       - `@paraharness/github`: `"dependencies": { "@paraharness/core": "workspace:*", "@octokit/rest": "^22.0.1", "@octokit/webhooks": "^14.2.0", "zod": "^4.6.7" }`.
       - `@paraharness/slack`: `"dependencies": { "@paraharness/core": "workspace:*", "@slack/socket-mode": "^3.1.1", "@slack/web-api": "^8.3.0", "@slack/webhook": "^8.0.2", "zod": "^4.6.7" }`.
       - `@paraharness/stripe`: `"dependencies": { "@paraharness/core": "workspace:*", "stripe": "^23.1.0", "zod": "^4.6.7" }`.
       - `@paraharness/netsuite`: `"dependencies": { "@paraharness/core": "workspace:*", "big.js": "^7.0.1", "zod": "^4.6.7" }`; extra `"devDependencies": { "@types/big.js": "^7.0.0" }`.
       - `@paraharness/integration`: `"dependencies": { "@paraharness/claude": "workspace:*", "@paraharness/core": "workspace:*", "@paraharness/fs": "workspace:*", "@paraharness/gemini": "workspace:*", "@paraharness/git": "workspace:*", "@paraharness/github": "workspace:*", "@paraharness/lockfile": "workspace:*", "@paraharness/markdown": "workspace:*", "@paraharness/netsuite": "workspace:*", "@paraharness/node": "workspace:*", "@paraharness/openai": "workspace:*", "@paraharness/postgres": "workspace:*", "@paraharness/slack": "workspace:*", "@paraharness/sqlite": "workspace:*", "@paraharness/stripe": "workspace:*", "zod": "^4.6.7" }`.
4. **`packages/<pkg>/tsconfig.json` for all 16 workspace packages**:
   - `{ "extends": "../../tsconfig.base.json", "compilerOptions": { "noEmit": true }, "include": ["src/**/*.ts", "test/**/*.ts"] }`.

### 4.1 Pure Passive Discriminated-Union AST, `CustomDomainAST<K>`, Zod `.default()` Variance & Generic Propagation (`SPEC.md` §1.2, §2.1, §2.2, §5 & `CODING_SAMPLE.md` §6)
1. **Passive AST Invariant**: Every AST node returned by `.toAST()` is a deeply frozen plain object (`Object.freeze`) discriminated by `readonly type: '...'` with zero execution methods (`.execute`, `.run`, `.evaluate`, `.acquireRoot`, `.forkChild`, `.commitChild`, `.serializeCheckpoint`, `.poll`, `.ask`, `.start`, `.load`).
2. **Builder Ergonomics & Property Projection**:
   - Every builder implements `AstBuilder<TNode>` (`.toAST(): TNode`) and is copy-on-write immutable (each fluent method returns a new builder instance without mutating prior instances).
   - Composition methods across all builders accept `MaybeBuilder<TNode>` (`TNode | AstBuilder<TNode>`) and normalize via `extractAST`.
   - Builders also expose the compiled node's readonly properties directly on the frozen builder instance (such as `id`, `type`, `schema` on `SignalBuilder`/`InterruptBuilder`, `reportSchema` on `CrossVerifierBuilder`, and `dependentsOf`/`affectedBy` on `TopologyBuilder`) so expressions like `leaseRequest.schema`, `normativeEscalation.schema`, `contractViolation.schema`, `crossTester.reportSchema`, and `repoTopology.affectedBy(v.partition)` (`CODING_SAMPLE.md` lines `764, 787–788, 978`) work seamlessly with or without `.toAST()`.
   - `P.command` supports both the 2-argument `P.command(id, { input, output, extractPartitions?, fn })` overload (`SPEC.md:29`) and the fluent `P.command(id).input(s).output(s).partitions(fn).run(fn)` builder chain.
   - `LaneTrackerConfigBuilder` populates `LaneNode.tracker.stateMappings` with exact keys `'queued'` (`.onQueued`), `'running'` (`.onRunning`), `'waiting'` (`.onWaiting`), `'errored'` (`.onErrored`), `'cancelled'` (`.onCancelled`), and `'exit:${exitState}'` (with fallback `exitState` for `.onExit(exitState, externalState)`).
3. **`CustomDomainAST<K>` Exact & Namespaced Key Resolution (`src/ast/custom-domain-ast-registry.ts` & `src/ast/domain-ast.types.ts`)**:
   - `CustomDomainASTRegistry` is defined in `src/ast/custom-domain-ast-registry.ts`, and `CustomDomainAST<K>` in `src/ast/domain-ast.types.ts` resolves both exact key `K` (e.g., `scope`, `guard`, `tool`, `check`, `abortHook`, `effectMatcher` in `SPEC.md:3256–3264`) and namespaced `${K}:${string}` keys (e.g., `'tool:stripe'`, `'guard:stripe'`, `'effectMatcher:stripe'`, `'scope:netsuite'`, `'guard:netsuite'`, `'tool:netsuite'`, `'check:netsuite'`, `'abortHook:netsuite'`) so multiple third-party domain packages can augment `CustomDomainASTRegistry` simultaneously without `TS2717` property type collisions while still evaluating to `never` when `CustomDomainASTRegistry` is `{}`:
     ```ts
     export type CustomDomainAST<K extends string> =
       | (K extends keyof CustomDomainASTRegistry ? CustomDomainASTRegistry[K] : never)
       | {
           [P in keyof CustomDomainASTRegistry]: P extends `${K}:${string}`
             ? CustomDomainASTRegistry[P]
             : never;
         }[keyof CustomDomainASTRegistry];
     ```
4. **Zod `.default()` Variance (`z.ZodType<T>`) & `FlowBuilder` / `LoopBuilder` Generic Propagation**:
   - All Zod schema properties on AST nodes (`SignalNode.schema`, `InterruptNode.schema`, `CommandNode.inputSchema`/`outputSchema`, `AgentNode.inputSchema`/`outputSchema`, `LoopNode.inputSchema`/`outputSchema`, `FlowBranchNode.outputSchema`, `FlowNode.inputSchema`, `LaneNode.inputSchema`, `BaseIsolationScopeASTNode.receiptSchema`/`syncSchema`, `BaseDomainStepASTNode.inputSchema`/`outputSchema`, `BaseTelemetryCollectorASTNode.schema`, `BaseAbortHookASTNode.metaSchema`, `BaseCrossVerifierASTNode.reportSchema`, `ForkCapabilityNode.requestSchema`, `SpeculateCapabilityNode.requestSchema`, `MutatePlanCapabilityNode.spawnTasks.itemSchema`, `EscalateCapabilityNode.responseSchema`, `ScopedHumanTargetNode.outputSchema`, `LessonsNode.querySchema`) and their corresponding builder method parameters must be typed as `z.ZodType<T>` (in Zod v4, `ZodType<out Output = unknown, out Input = unknown>` is covariant in `Input` and defaults `Input = unknown`) so `T` always infers as `z.output<S>` across schemas using `.default(...)` (such as `workItem`, `workReceipt`, `evaluationResult`, `forkRequestSchema`, `arbiterVerdictSchema`, `ownerDecisionSchema`, and `git.ScopeReceiptSchema`).
   - `FlowBuilder<TIn, THandle, TStepIds, TReceipt, TCustomMetrics, TStepOutputs>` propagates:
     - `TReceipt` (inferred from `.scope(scope)`'s `IsolationScopeASTNode<THandle, TReceipt, any, any>`),
     - `TCustomMetrics` (inferred from `.telemetry(collector)`'s `TelemetryCollectorASTNode<TCustomMetrics>`),
     - `TAbortMeta` (inferred from `.onAbort(hook)` on `PolicyBuilder` and `InterruptEdgeBuilder`), and
     - `TStepOutputs extends Record<string, unknown> = {}` (recording each `.step(id, step)` and `.branch(id, $b => $b.output(schema)...)` output under its literal key `TStepId`)
     through `FlowBuilder`, `FlowStepConfigBuilder`, and `InterruptEdgeBuilder` so `steps['execute-work']`, `scopeReceipt` (`scopeReceipt.baseBranch`), `telemetry.custom.filesRead`, and `telemetry.abortMeta?.abortedSnapshotRef` are strongly typed without casts or `undefined` errors under `strict: true` and `noUncheckedIndexedAccess: true`.
   - `LoopBuilder.act(stepId, actor)` unconditionally sets `inputSchema: actorNode.inputSchema` and `outputSchema: actorNode.outputSchema`, inherits `extractPartitions: state.extractPartitions ?? actorNode.extractPartitions`, and defaults `returnOutputFromStepId` to `state.returnOutputFromStepId ?? stepId` (with `maxIterations` defaulting to `3`). `LoopBuilder.evaluate<TEvalIn, TEvalOut>` infers `TEvalIn` and `TEvalOut` from `evaluator: MaybeBuilder<AgentNode<TEvalIn, TEvalOut, THandle>>` and types `mapInput: (loopInput: TIn, actOutput: TOut, scopeReceipt: TReceipt) => TEvalIn`, `acceptWhen: (evalOut: TEvalOut) => boolean`, and `feedbackMapper: (evalOut: TEvalOut) => string`.
   - `SpeculationCandidateSchema` and `SpeculationInputSchema` make `crossSchema?: TCross` optional (defaulting `TCross = z.ZodTypeAny` and `crossVerifyReport: (crossSchema ?? z.unknown()).optional()`), `SpeculateCapabilityBuilder.arbiter` supports both the 1-argument overload `arbiter<TArbiterIn, TArbiterOut extends SpeculateArbiterDecision>(arbiterActor, options?)` (defaulting `resolveDecision` to identity `(verdict) => verdict` while preserving `TArbiterIn` onto `SpeculateCapabilityBuilder` so `ExtractSpeculationCandidate<TArbiterIn>` flows into `.refineWinnerWhen()` and `.verifyWinnerWith()`) and the 2-argument custom `resolveDecision` overload, `SpeculateCapabilityBuilder.verifyWinnerWith<TEvalIn, TEvalOut, TReceipt>` infers `TEvalIn` and `TEvalOut` from `evaluator` (`{ readonly mapInput: (branchInput: TChildIn, branchOutput: TChildOut, scopeReceipt: TReceipt) => TEvalIn; readonly acceptWhen: (evalOut: TEvalOut) => boolean }`), `AgentCapabilitiesBuilder.fork(toolName, childActor, configure?)` makes `configure` optional (defaulting `requestSchema` to `childNode.inputSchema` and `mapInput` to `(_parentIn, req) => req`), and `AdjudicateInterruptBuilder.onInterrupt` preserves `TAdjIn` (`($esc: InterruptEdgeBuilder<TAdjIn, TInnerPayload, THandle, TReceipt, TCustomMetrics, TAbortMeta>) => InterruptEdgeBuilder<TAdjIn, TInnerPayload, THandle, TReceipt, TCustomMetrics, TAbortMeta>`).

### 4.2 Static Build-Time Validation Rules (`SPEC.md` §1.2, §3.5, §3.6, §3.7.2, §3.8, §3.9, §3.10)
1. **Topology DAG Validation (`P.topology(id).partitions(...)`)**:
   - Validates non-empty partition IDs, rejects unknown `dependsOn` partition IDs, and rejects self-loops or directed cycles via `@dagrejs/graphlib` (`Graph`, `alg.findCycles`, `alg.preorder` per `docs/CODING_GUIDELINES.md` Rule 3.5) with an actionable `Error`.
   - `dependentsOf(topology, partitionId)` returns all strict transitive dependent partition IDs (`dependentsOf(repoTopology, 'db')` -> `['api', 'web']`).
   - `affectedBy(topology, partitionId)` returns `[partitionId, ...dependentsOf(topology, partitionId)]` (`affectedBy(repoTopology, 'db')` -> `['db', 'api', 'web']`).
2. **Capability Tier Validation on `P.flow` (`SPEC.md` §1.2 Invariant 1, §3.5, §3.7.2, §3.9)**:
   - Inspects `scopeNode.capabilityTier` (`'scope' | 'checkpointable' | 'branchable'`) statically at build time (never duck-typing runtime methods):
     - If any actor in `flow.nodes` declares `.fork()`, `.speculate()`, or `.mutatePlan()` with `spawnTasks` (`onPrerequisiteSpawned: 'suspend-and-yield-slot'`) or `canAddDependencies`, requires `scopeNode.capabilityTier === 'branchable'` (`supportsBranching: true`).
     - If any actor in `flow.nodes` mounts a `ToolASTNode` with `effectTracking === 'subprocess-post-flight'` alongside any `PolicyGuardASTNode`, or if any `.replaceWith()` edge omits `.onAbort()` on both the interrupt edge and the actor's `PolicyNode`, requires `scopeNode.capabilityTier === 'checkpointable' || scopeNode.capabilityTier === 'branchable'` (`supportsCheckpoints: true`).
3. **Prefix Group `'clone-transcript'` Validation (`SPEC.md` §3.2.1 & §3.7.2)**:
   - If an actor bound to `PrefixGroupNode` with `toolsMode === 'role-scoped'` configures `.fork(..., $f => $f.historyMode('clone-transcript'))` where the child actor has a distinct `roleKey`, throws an actionable build-time `Error` requiring `toolsMode('union')`.
4. **Human Channel `interactionMode` Validation & Builder Shorthands (`SPEC.md` §1.2 Invariant 1, §3.6, §3.7.2, §3.10)**:
   - Whenever an `P.human` node is bound to `.ask(human, schema)`, `.escalate(..., $esc => $esc.to(human)...)`, `human.withName(alias).output(schema)`, or `P.lane.maxCostUsd(limit, humanOrScopedHuman)` (where `maxCostUsd` accepts either `MaybeBuilder<ScopedHumanTargetNode<z.infer<typeof BudgetApprovalSchema>>>` or a direct `MaybeBuilder<HumanNode<'bidirectional'>>` auto-desugaring to `{ type: 'harness:scoped-human', human: humanNode, alias: `${humanNode.id}:budget-approver`, outputSchema: BudgetApprovalSchema }`), statically verifies `human.channel.interactionMode === 'bidirectional'` (rejecting `'notify-only'` channels such as `SlackNotifierNode` at build time).
   - `AgentBuilder.onChildInterrupt(interrupt, configure?)` makes `configure` optional (defaulting to `{ type: 'harness:child-interrupt-handler', mode: 'suspend-and-return-to-parent', interrupt, pauseSiblingForksInPartitions: undefined }` when omitted), and `HarnessBuilder.onSignal` supports both `.onSignal(signal, $s => $s.notify(human, messageMapper))` and the 3-argument shorthand `.onSignal(signal, human, messageMapper)`.
5. **Canonical `roleKey` Derivation on `.withTools()` and `.withPolicy()` (`SPEC.md` §3.2.1, §3.7.1, §3.8)**:
   - Base `P.agent(id)` initializes `roleKey = id`; base `P.loop(id).act(stepId, actor)` initializes `roleKey = actor.roleKey`.
   - `agent.withTools(...extraTools)` and `loop.withTools(...extraTools)` flatten `extraTools`, extract each tool's `name`, sort the extra tool names lexicographically, and set `roleKey = "${baseActorId}+tools:${sortedExtraToolNames.join(',')}"` (preserving order-independence across different argument orderings) while preserving `.prefixGroup()`, `.partitions()`, `.topology()`, all actor-level `.onInterrupt()` handlers, rules, skills, lessons, and `beforeStop` checks.
   - `agent.withPolicy(newPolicy)` and `loop.withPolicy(newPolicy)` preserve all actor-level `.onInterrupt()` handlers on the `.act()` actor while leaving `.evaluate()`'s `readOnlyPolicy` intact.
6. **Compile-Time & Build-Time Step ID Constraints (`SPEC.md` §3.8 & §3.10)**:
   - `P.loop.returnOutputFrom(actStepId: TActStepId)` constrains `actStepId` to the literal `TActStepId` passed to `.act(stepId, ...)` and verifies equality at build time.
   - `P.lane.onSignal(sig, $s => $s.update(mapper).rewindTo(stepId: TStepIds, ...))` constrains `stepId` to the literal `TStepIds` union of `flow` and verifies at build time that `stepId` exists in `flow.nodes`.

---

## 5. Deterministic Test Suite Architecture (`packages/lockfile/test/**` & `packages/core/test/**`)

All test files obey [`docs/CODING_GUIDELINES.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_GUIDELINES.md) §6 (focused per-subsystem `*.test.ts` files, shared fixtures in `test/fixtures/**` with single-entity-kind separation, single responsibility at one level of abstraction, complete §2 JSDoc, and exact structural assertions):

| File Path | Primary Category | Required Deterministic Test Cases |
| :--- | :--- | :--- |
| `packages/lockfile/test/with-file-lock.test.ts` | `test` | 1. Verifies in-process FIFO mutual exclusion (`p-queue` `concurrency: 1`) and cross-process atomic `open(lockPath, 'wx')` exclusion across real temporary directories (`mkdtemp`).<br>2. Verifies dead-PID (`ESRCH`) and stale-`mtime` lock reclamation, `.unref()`ed `utimes` heartbeat renewal, queued-wait `AbortSignal` cancellation without mid-critical-section slot release (`docs/lessons/BUILDER.md`), and deterministic `try / finally` lock cleanup. |
| `packages/core/test/fixtures/sample-domain-nodes.constants.ts` | `fixture (const)` | Pure `const` passive `DomainASTNode` fixture instances (`SAMPLE_TIER1_SCOPE_NODE` with `capabilityTier: 'scope'`, `SAMPLE_TIER2_SCOPE_NODE` with `capabilityTier: 'checkpointable'`, `SAMPLE_TIER3_SCOPE_NODE` with `capabilityTier: 'branchable'`, `SAMPLE_DECLARED_TOOL_NODE`, `SAMPLE_POST_FLIGHT_SUBPROCESS_TOOL_NODE`, `SAMPLE_GUARD_NODE`, `SAMPLE_BIDIRECTIONAL_HUMAN_CHANNEL_NODE`, `SAMPLE_NOTIFY_ONLY_HUMAN_CHANNEL_NODE`, `SAMPLE_MODEL_NODE`). |
| `packages/core/test/ast-and-schemas.test.ts` | `test` | 1. Verifies `extractAST`, `P.env(key)` symbolic `EnvRef` serialization (never reading `process.env`), `ScopePredicateSchema`, `GlobalRuleSchema`, `ScopedRuleSchema`, `BudgetApprovalSchema`, `ResumeForkInputSchema`, `SpeculationCandidateSchema`, and `SpeculationInputSchema` (including 5-argument invocation with union escalation schema from `CODING_SAMPLE.md` lines `783–789`).<br>2. Verifies `zodToJsonSchema` (via Zod v4 `z.toJSONSchema()`) across primitives, literals, enums, arrays, tuples, records, nested objects with `.optional()` and `.default()`, discriminated unions, intersections, and deep-freeze invariants.<br>3. Verifies `CustomDomainASTRegistry` declaration merging (`CustomDomainAST<K>`) across both exact keys `K` and namespaced `${K}:${string}` keys. |
| `packages/core/test/topology-and-builders.test.ts` | `test` | 1. Verifies `P.topology` DAG validation via `@dagrejs/graphlib` (accepting valid `db <- api <- web` graph; rejecting unknown dependencies, self-cycles, and multi-node cycles with exact error messages).<br>2. Verifies `dependentsOf` (`'db' -> ['api', 'web']`, `'api' -> ['web']`, `'web' -> []`) and `affectedBy` (`'db' -> ['db', 'api', 'web']`) both as standalone functions and as methods on `TopologyBuilder`.<br>3. Verifies copy-on-write immutability, `.toAST()` deep-freeze, Zod `.default()` output type inference, and all builder chains for `P.signal`, `P.interrupt`, `P.stream`, `P.pool` (`soonest-reset`, `round-robin`, `least-used`, `escalateOnRetry`, `custom`, `fallback`), `P.prefixGroup`, `P.rules`, `P.scopedRule`, `P.skill`, `P.lessons`, `P.policy` (including `.extend()`), `P.human`, `P.command` (both 2-argument `P.command(id, { input, output, extractPartitions?, fn })` and fluent builder chain, verifying zero `.execute` method on `CommandNode`), `P.agent`, `P.loop`, and `createExecutorRegistry`.<br>4. Verifies `.withTools()` canonical order-independent `roleKey` (`"${baseActor.id}+tools:${sortedExtraToolNames.join(',')}"`) and `.withPolicy()` preservation of actor-level `.onInterrupt()` handlers. |
| `packages/core/test/flow-and-validation.test.ts` | `test` | 1. Verifies `P.flow` (`.step()`, `.branch()` with `.when()` / `.otherwise()`, `.inputFrom()` with strongly typed `steps[branchId]` and `scopeReceipt`, `.onInterrupt()` adjudicate/ask/replace modes with strongly typed `telemetry.custom` and `telemetry.abortMeta`), `P.lane` (`.tracker()` populating canonical `stateMappings` keys `'queued'`, `'running'`, `'waiting'`, `'errored'`, `'cancelled'`, `'exit:${exitState}'`, `.waitFor()`, `.maxCostUsd()`, `.retry()`, `.onSignal().rewindTo()`), and `P.harness`.<br>2. Verifies static build-time rejections: (a) `.fork()` / `.speculate()` / `.mutatePlan()` on a Tier-1 `'scope'` or Tier-2 `'checkpointable'` scope; (b) `effectTracking: 'subprocess-post-flight'` tool under a policy guard on a Tier-1 `'scope'` scope; (c) `.replaceWith()` without `.onAbort()` on a Tier-1 `'scope'` scope; (d) `'clone-transcript'` fork across distinct roles under `toolsMode: 'role-scoped'`; (e) `.ask()`, `.escalate()`, or `.maxCostUsd()` targeting a `'notify-only'` human channel; (f) invalid `.returnOutputFrom()` or `.rewindTo()` step IDs. |

---

## 6. Verification Gate Commands

Run from workspace root (along with the `docs/IMPL_LOOP.md` `baseline_dirty` check verifying zero new or newly modified files in `<non_sibling_forbidden_dirs_excluding_upstream_patches>` relative to `baseline_dirty`):

```bash
pnpm --filter @paraharness/lockfile --filter @paraharness/core lint
pnpm --filter @paraharness/lockfile --filter @paraharness/core typecheck
pnpm --filter @paraharness/lockfile --filter @paraharness/core test -- --reporter=verbose
test -z "$(git status --porcelain -- docs .agents .claude package.json tsconfig.base.json vitest.config.ts)"
```
