# Milestone M1 — Workspace Bootstrap & `@harness-dsl/core` Pure AST, Ports, Schemas, Topology & Fluent Builders (`H.*`)

## 1. Scope & Ownership (`owned_dirs` & `forbidden_dirs`)

- **Milestone**: `M1` (Wave 1a — Sequential Core Spine `b`)
- **Package**: `@harness-dsl/core` (`packages/core`) and Monorepo Workspace Manifests
- **`owned_dirs`**:
  - Root workspace configuration: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`
  - Package manifests and TypeScript configs for all 15 workspace packages: `packages/{core,sqlite,postgres,fs,markdown,node,git,claude,openai,gemini,github,slack,stripe,netsuite,integration}/{package.json,tsconfig.json}`
  - `@harness-dsl/core` contract, AST, port, schema, topology, and builder directories:
    - `packages/core/src/ast/**`
    - `packages/core/src/ports/**`
    - `packages/core/src/schemas/**`
    - `packages/core/src/topology/**`
    - `packages/core/src/builders/**`
    - `packages/core/src/index.ts`
    - `packages/core/src/runtime/index.ts` (initial barrel re-exporting `createExecutorRegistry` and runtime port contracts; expanded in `M2`)
  - `@harness-dsl/core` M1 test suites and fixtures:
    - `packages/core/test/fixtures/**`
    - `packages/core/test/ast-and-schemas.test.ts`
    - `packages/core/test/topology-and-builders.test.ts`
    - `packages/core/test/flow-and-validation.test.ts`
- **`forbidden_dirs`**:
  - `packages/core/src/runtime/**` (except `packages/core/src/runtime/index.ts`, which is owned by `M1` in Wave 1a and expanded by `M2` in Wave 1b)
  - `packages/{sqlite,postgres,fs,markdown,node,git,claude,openai,gemini,github,slack,stripe,netsuite,integration}/src/**`
  - `packages/{sqlite,postgres,fs,markdown,node,git,claude,openai,gemini,github,slack,stripe,netsuite,integration}/test/**`
  - `.agents/**`, `.claude/**`, `docs/**`

---

## 2. Normative Specification & Coding Sample Grounding

| Normative Source | Section & Exact Line Range | Grounded Scope in `M1` |
| :--- | :--- | :--- |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §1.1–§1.2 (`lines 3–34`) | Package boundaries (`line 13`) and Declarative Compilation & Serialization Invariants 1–6 (`lines 26–34`): pure passive discriminated-union AST nodes (`readonly type: '...'`), fluent `AstBuilder<TNode>.toAST()`, static build-time validation of `capabilityTier`, `effectTracking`, and `interactionMode` without duck-typing runtime methods, symbolic `H.env(key)` (`EnvRef`), and zero execution methods on AST nodes. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §2.1 (`lines 44–680`) | Pure Passive AST Foundation: `ASTNode`, `AstBuilder<TNode>`, `MaybeBuilder<TNode>`, `extractAST`, `SourceValue<T>`, `MaybeSource<T>`, `EnvRef`, `SignalNode`, `SignalBuilder`, `InterruptNode`, `InterruptBuilder`, `CrossVerifierBuilder`, `TopologyBuilder`, `dependentsOf`, `affectedBy`, `StreamNode`, `PoolStrategyNode`, `PoolNode`, `PrefixGroupNode`, `TopologyNode`, `ScopedRuleNode`, `RulesNode`, `SkillNode`, `LessonsNode`, `PolicyViolation`, `PolicyGuardClauseNode`, `PolicyNode`, `HumanNode`, `ScopedHumanTargetNode`, `CompactionConfigNode`, `CommandNode`, `ForkCapabilityNode`, `SpeculateCapabilityNode`, `MutatePlanCapabilityNode`, `EscalateCapabilityNode`, `AgentCapabilitiesNode`, `ChildInterruptHandlerNode`, `InterruptHandlerNode`, `AgentNode`, `LoopNode`, `FlowStepNode`, `FlowBranchNode`, `FlowNode`, `LaneNode`, `HarnessNode`, and `CoreASTNode`. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §2.2 (`lines 682–1092`) | Domain-Agnostic Base AST Node Contracts (`ScopeCapabilityTier`, `BaseIsolationScopeASTNode`, `BaseDomainStepASTNode`, `BaseStepASTNode`, `BaseToolASTNode`, `BaseCheckASTNode`, `BaseServiceASTNode`, `BasePolicyGuardASTNode`, `BaseQuotaTripwireASTNode`, `BaseTelemetryCollectorASTNode`, `BaseAbortHookASTNode`, `BaseScopeRewindHookASTNode`, `BaseCrossVerifierASTNode`, `BaseSourceASTNode`, `BaseAccountSeatASTNode`, `BaseModelASTNode`, `BaseLedgerStoreASTNode`, `BaseTopologyStoreASTNode`, `BaseLessonStoreASTNode`, `BaseTrackerASTNode`, `BaseStreamSourceASTNode`, `BaseHumanChannelASTNode`, `BaseControlPlaneASTNode`, `BaseEffectMatcherASTNode`, `BaseRunnerPoolASTNode`), `CustomDomainASTRegistry`, `CustomDomainAST<K>`, and all workspace category unions (`IsolationScopeASTNode` through `DomainASTNode`). |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §2.3–§2.8 (`lines 1094–2123`) | Universal `NodeExecutor`, `NodeExecutorMap`, `RuntimeDriverContext`, `StepExecutionContext`, `RuntimeExecutorRegistry`, `RuntimeExecutorRegistrySlice`, `HarnessRuntime`, `HarnessRuntimeOptions`, `HarnessExecutionEngine`, `ResolutionContext`, `ToolEffect`, `LeaseDelta`, `RunnerDriver`, `ExecutionContext`, `ToolDriver`, `ServiceSession`, `ReconcileResult`, `IsolationScope`, `CheckpointableScope`, `BranchableScope`, `CanonicalMessage`, `WireFrameRecord`, `WireToolSchema`, `CompiledWirePrefix`, `ForkContext`, `ModelDriver`, `UniversalStepTelemetry`, `PendingPreFlightCall`, `PendingToolBatch`, `AgentPauseState`, `ContinuationFrame`, `SuspendedForkRecord`, `LedgerStore`, `TopologyPartitionState`, `TopologyStore`, `LessonOutcome`, `DistilledLessonCandidate`, `LessonRecord`, `LessonStore`, `TrackerAdapter`, `StreamSource`, `HumanAdapter`, `ControlPlaneAdapter`, and `HarnessRuntimeController`. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §3.1–§3.10 (`lines 2127–2616`) | `PoolCandidateState`, `PoolSelectionContext`, `PoolSelectorFn` (`lines 2142–2167`), `ScopePredicateSchema`, `ScopePredicate`, `GlobalRuleSchema`, `GlobalRule`, `ScopedRuleSchema`, `ScopedRule` (`lines 2218–2241`), `SpeculationCandidateSchema`, `SpeculationInputSchema` (`lines 2377–2445`), `ResumeForkInputSchema` (`lines 2518–2522`), `BudgetApprovalSchema` (`lines 2600–2603`), `DistilledLessonCandidate` (`lines 2045–2049`), and all fluent `H.*` builder chains, `.withPolicy()` / `.withTools()` canonical `roleKey` derivation, and static build-time validations. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §4.1–§4.5 (`lines 2619–3179`) | Concrete passive `DomainASTNode` interfaces (`ClaudeAccountSeatNode` through `SlackNotifierNode`) exported from `@harness-dsl/core` so `M3a..M3f` have zero cross-adapter imports. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §5 (`lines 3182–3324`) | `CustomDomainASTRegistry` declaration merging and Tier-1 `IsolationScope` (`capabilityTier: 'scope'`) static build-time validation. |
| [`docs/CODING_SAMPLE.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_SAMPLE.md) | §3.1 (`lines 106–115`) & §6 (`lines 176–1208`) | All `H.*` builder invocations in `engineering-harness.ts`, `repoTopology.dependentsOf` / `repoTopology.affectedBy`, `H.SpeculationInputSchema`, `H.BudgetApprovalSchema`, and re-exported `z` from `@harness-dsl/core`. |

---

## 3. Planned Module Decomposition & Public Exports (`packages/core/src/**`)

Every file in `packages/core/src/**` and `packages/core/test/fixtures/**` adheres to [`docs/CODING_GUIDELINES.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_GUIDELINES.md) §1–§5 (`<= 250` lines per file, one primary concept per file, pure `index.ts` barrels, strict acyclic DAG imports, complete `/** ... */` JSDoc on every declaration and property, and zero inline/non-JSDoc comments).

### 3.1 AST Layer (`packages/core/src/ast/**`)

| File Path | Primary Category | Exported Symbols |
| :--- | :--- | :--- |
| `src/ast/ast-node.ts` | `interface` | `ASTNode`, `AstBuilder<TNode>` |
| `src/ast/ast-foundation.types.ts` | `type` | `MaybeBuilder<TNode>`, `SourceValue<T>`, `MaybeSource<T>`, `ScopeCapabilityTier` |
| `src/ast/extract-ast.ts` | `function` | `extractAST<TNode extends ASTNode>(input: MaybeBuilder<TNode>): TNode` |
| `src/ast/env-ref.ts` | `interface` | `EnvRef` |
| `src/ast/signal-node.ts` | `interface` | `SignalNode<TPayload>`, `SignalBuilder<TPayload>` |
| `src/ast/interrupt-node.ts` | `interface` | `InterruptNode<TPayload>`, `InterruptBuilder<TPayload>` |
| `src/ast/cross-verifier-builder.ts` | `interface` | `CrossVerifierBuilder<THandle, TReceipt, TCrossReport, TNode>` |
| `src/ast/topology-builder.ts` | `interface` | `TopologyBuilder<TPartition>` |
| `src/ast/stream-node.ts` | `interface` | `StreamNode<TEvent, TPayload>` |
| `src/ast/pool-candidate-state.ts` | `interface` | `PoolCandidateState<TItem>`, `PoolSelectionContext`, `PoolSelectorFn<TItem>` |
| `src/ast/pool-node.ts` | `interface` | `PoolNode<TItem>`, `PoolStrategyNode<TItem>`, `StandardPoolStrategyNode`, `EscalateOnRetryPoolStrategyNode`, `CustomPoolStrategyNode<TItem>` |
| `src/ast/prefix-group-node.ts` | `interface` | `PrefixGroupNode` |
| `src/ast/topology-node.ts` | `interface` | `TopologyNode<TPartition>`, `TopologyPartitionConstraint<TPartition>`, `TopologyCommitOverlayConfig`, `TopologySignalCorrelation<TSig>` |
| `src/ast/scoped-rule-node.ts` | `interface` | `ScopedRuleNode`, `InlineScopedRuleNode`, `SourcedScopedRuleNode` |
| `src/ast/rules-node.ts` | `interface` | `RulesNode` |
| `src/ast/skill-node.ts` | `interface` | `SkillNode<THandle>`, `InlineSkillNode<THandle>`, `SourcedSkillNode<THandle>` |
| `src/ast/lessons-node.ts` | `interface` | `LessonsNode<TIn>`, `LessonDistillationConfig`, `LessonScoringConfig`, `LessonRetirementConfig`, `LessonEmitSignalTrigger` |
| `src/ast/policy-node.ts` | `interface` | `PolicyNode<THandle>`, `PolicyViolation`, `PolicyGuardClauseNode`, `DenyWithErrorPolicyGuardClauseNode`, `RaiseInterruptPolicyGuardClauseNode`, `PolicyLimitExceededConfig<THandle>` |
| `src/ast/human-node.ts` | `interface` | `HumanNode<TMode>`, `ScopedHumanTargetNode<TResponse>` |
| `src/ast/compaction-config-node.ts` | `interface` | `CompactionConfigNode`, `CompactionSignalTrigger`, `CompactionTerminalExitTrigger` |
| `src/ast/command-node.ts` | `interface` | `CommandNode<TIn, TOut, THandle>` |
| `src/ast/fork-capability-node.ts` | `interface` | `ForkCapabilityNode<TParentIn, TReq, TChildIn, TChildOut, THandle>`, `ForkModelRoutingConfig<TParentIn, TReq>` |
| `src/ast/speculate-capability-node.ts` | `interface` | `SpeculateCapabilityNode<TParentIn, TReq, TChildIn, TChildOut, THandle, TCrossReport, TVerdict>`, `SpeculateArbiterDecision`, `SpeculateArbiterConfig<THandle, TVerdict>`, `SpeculateVerifyWinnerConfig<TChildIn, TChildOut, THandle>`, `SpeculateRefineWinnerConfig<TParentIn, TChildIn, TChildOut, THandle, TVerdict>` |
| `src/ast/mutate-plan-capability-node.ts` | `interface` | `MutatePlanCapabilityNode<TItem>`, `SpawnTasksConfig<TItem>` |
| `src/ast/escalate-capability-node.ts` | `interface` | `EscalateCapabilityNode<TPayload, TResponse>`, `EscalateLeaseElevationConfig<TResponse>` |
| `src/ast/agent-capabilities-node.ts` | `interface` | `AgentCapabilitiesNode<TParentIn, THandle>` |
| `src/ast/child-interrupt-handler-node.ts` | `interface` | `ChildInterruptHandlerNode<TPayload>` |
| `src/ast/interrupt-handler-node.ts` | `interface` | `InterruptHandlerNode<TIn, TPayload, THandle>`, `AdjudicateInterruptHandlerNode<TIn, TPayload, THandle>`, `AskInterruptHandlerNode<TPayload>`, `ReplaceInterruptHandlerNode<TIn, TPayload, THandle>` |
| `src/ast/agent-node.ts` | `interface` | `AgentNode<TIn, TOut, THandle>`, `AgentLessonsMount` |
| `src/ast/loop-node.ts` | `interface` | `LoopNode<TIn, TOut, THandle, TActStepId>`, `LoopActStepConfig<TIn, TOut, THandle, TActStepId>`, `LoopEvaluateStepConfig<TIn, TOut, THandle>` |
| `src/ast/flow-step-node.ts` | `interface` | `FlowStepNode<TIn, TOut, THandle, TStepId>` |
| `src/ast/flow-branch-node.ts` | `interface` | `FlowBranchNode<TFlowIn, TBranchOut, THandle, TBranchId>`, `FlowBranchCase<TFlowIn, THandle>` |
| `src/ast/flow-node.ts` | `interface` | `FlowNode<TIn, THandle, TStepIds>` |
| `src/ast/lane-node.ts` | `interface` | `LaneNode<TIn, TStepIds>`, `LaneTrackerConfig<TIn>`, `LaneWaitForConfig<TIn>`, `LaneMaxCostConfig`, `LaneRetryConfig`, `LaneSignalHandlerConfig<TIn, TStepIds>` |
| `src/ast/harness-node.ts` | `interface` | `HarnessNode`, `HarnessSignalNotification` |
| `src/ast/base/base-isolation-scope-ast-node.ts` | `interface` | `BaseIsolationScopeASTNode<TType, THandle, TReceipt, TSync, TTier>` |
| `src/ast/base/base-step-and-tool-ast-nodes.ts` | `interface` | `BaseDomainStepASTNode<TType, TIn, TOut, THandle>`, `BaseStepASTNode<TType, TIn, TOut, THandle>`, `BaseToolASTNode<TType, TTracking, THandle>`, `BaseCheckASTNode<TType, THandle>`, `BaseServiceASTNode<TType, THandle>`, `ServiceToolSchemaDescriptor` |
| `src/ast/base/base-policy-and-hook-ast-nodes.ts` | `interface` | `BasePolicyGuardASTNode<TType>`, `BaseQuotaTripwireASTNode<TType>`, `BaseTelemetryCollectorASTNode<TType, TMetrics>`, `BaseAbortHookASTNode<TType, THandle, TAbortMeta>`, `BaseScopeRewindHookASTNode<TType, THandle>`, `BaseCrossVerifierASTNode<TType, THandle, TReceipt, TCrossReport>`, `BaseEffectMatcherASTNode<TType>` |
| `src/ast/base/base-store-and-connector-ast-nodes.ts` | `interface` | `BaseSourceASTNode<TType, T>`, `BaseAccountSeatASTNode<TType>`, `BaseModelASTNode<TType, TSeat>`, `BaseLedgerStoreASTNode<TType>`, `BaseTopologyStoreASTNode<TType>`, `BaseLessonStoreASTNode<TType>`, `BaseTrackerASTNode<TType, TExternal, TExternalState>`, `BaseStreamSourceASTNode<TType, TEvent>`, `BaseHumanChannelASTNode<TType, TMode>`, `BaseControlPlaneASTNode<TType>`, `BaseRunnerPoolASTNode<TType>` |
| `src/ast/custom-domain-ast-registry.ts` | `interface` | `CustomDomainASTRegistry`, `CustomDomainAST<K>` |
| `src/ast/domain/model-domain-nodes.ts` | `interface` | `ClaudeAccountSeatNode`, `ClaudeModelNode`, `OpenAiAccountSeatNode`, `OpenAiModelNode`, `GeminiAccountSeatNode`, `GeminiModelNode`, `ClaudeAccountNode`, `ClaudeEvaluatorNode`, `OpenAiAccountNode`, `OpenAiEvaluatorNode`, `GeminiAccountNode`, `GeminiEvaluatorNode` |
| `src/ast/domain/node-domain-nodes.ts` | `interface` | `NodeRunnerNode`, `LocalCommandNode<TIn, TOut, THandle>`, `LocalCommandCheckNode<THandle>`, `LocalCommandToolNode<THandle>`, `LocalStreamCheckNode<THandle>`, `LocalStreamCheckToolNode<THandle>`, `LocalServiceNode`, `LocalServiceToolNode<THandle>`, `NodeAllowBinariesNode`, `NodeDenyNetworkNode`, `NodeHttpControlPlaneNode`, `NodeMcpStdioNode`, `NodeMcpSseNode` |
| `src/ast/domain/fs-tool-and-source-nodes.ts` | `interface` | `FsReadToolNode<THandle>`, `FsEditToolNode<THandle>`, `FsWriteToolNode<THandle>`, `FsGlobToolNode<THandle>`, `FsGrepToolNode<THandle>`, `FsTextSourceNode`, `FsGlobSourceNode`, `FsGlobMatcherNode`, `FsPartitionMapNode<TPartition>` |
| `src/ast/domain/fs-guard-and-store-nodes.ts` | `interface` | `FsBoundaryGuardNode`, `FsWriteGuardNode`, `FsProtectGuardNode`, `FsReadOnlyGuardNode`, `FsAllowOnlyGuardNode`, `FsRequireReadBeforeWriteGuardNode`, `FsScopedWriteGuardNode`, `FsSecretLiteralsGuardNode`, `FsQuotaTripwireNode`, `FsTelemetryCollectorNode`, `FsRegexCheckNode<THandle>`, `FsJsonlLessonStoreNode` |
| `src/ast/domain/git-worktree-and-step-nodes.ts` | `interface` | `GitWorktreeHandle`, `GitScopeReceipt`, `GitSyncReceipt`, `GitAbortMeta`, `GitCleanWorkingTreeNode`, `GitCowWorktreeNode<THandle, TReceipt, TSync>`, `GitCommitAndPushNode<TIn>`, `GitMergeQueueNode<TIn, TOut>` |
| `src/ast/domain/git-hook-and-tool-nodes.ts` | `interface` | `GitSnapshotAndResetNode`, `GitKeepWorktreeNode`, `GitDiscardBranchNode`, `GitPatchEquivalenceNode<TCrossReport>`, `GitPublicSurfaceCrossTesterNode<TCrossReport>`, `GitRefReaderToolNode<THandle>`, `GitCandidateComparisonToolNode<THandle>` |
| `src/ast/domain/storage-and-connector-nodes.ts` | `interface` | `MarkdownFrontmatterSourceNode<T>`, `MarkdownSectionSourceNode<T>`, `SqliteLedgerNode`, `PostgresLedgerNode`, `SqliteTopologyNode`, `PostgresTopologyNode`, `SqliteLessonsNode`, `PostgresLessonsNode`, `SqliteRulesSourceNode`, `PostgresRulesSourceNode`, `GithubIssuesTrackerNode<TExternal, TExternalState>`, `GithubWebhookStreamNode<TEvent>`, `GithubCreateOrUpdatePrNode<TIn, TOut, THandle>`, `SlackApproverNode`, `SlackSocketModeControlPlaneNode`, `SlackNotifierNode` |
| `src/ast/domain-ast.types.ts` | `type` | `IsolationScopeASTNode`, `DomainStepASTNode`, `StepASTNode`, `BuiltInToolASTNode`, `ToolASTNode`, `BuiltInCheckASTNode`, `CheckASTNode`, `EvaluatorASTNode`, `ServiceASTNode`, `BuiltInGuardASTNode`, `GuardASTNode`, `PolicyGuardASTNode`, `QuotaTripwireASTNode`, `TelemetryCollectorASTNode`, `AbortHookASTNode`, `ScopeRewindHookASTNode`, `PatchEquivalenceASTNode`, `CrossTesterASTNode`, `CrossVerifierASTNode`, `SourceASTNode`, `AccountSeatASTNode`, `ModelASTNode`, `LedgerStoreASTNode`, `TopologyStoreASTNode`, `LessonStoreASTNode`, `TrackerASTNode`, `StreamSourceASTNode`, `HumanChannelASTNode`, `ControlPlaneASTNode`, `EffectMatcherASTNode`, `RunnerPoolASTNode`, `DomainASTNode`, `CoreASTNode` |

### 3.2 Ports Layer (`packages/core/src/ports/**`)

| File Path | Primary Category | Exported Symbols |
| :--- | :--- | :--- |
| `src/ports/node-executor.types.ts` | `type` | `NodeExecutor<TNode, TInput, TOutput, TContext>`, `NodeExecutorMap<TUnion, TInput, TOutput, TContext>` |
| `src/ports/runtime-driver-context.ts` | `interface` | `RuntimeDriverContext` |
| `src/ports/execution-context.ts` | `interface` | `ExecutionContext<THandle>` |
| `src/ports/step-execution-context.ts` | `interface` | `StepExecutionContext<THandle>` |
| `src/ports/runtime-executor-registry.ts` | `interface` | `RuntimeExecutorRegistry`, `RuntimeExecutorRegistrySlice` |
| `src/ports/create-executor-registry.ts` | `function` | `createExecutorRegistry(...slices: ReadonlyArray<RuntimeExecutorRegistrySlice \| readonly RuntimeExecutorRegistrySlice[]>): RuntimeExecutorRegistry` |
| `src/ports/harness-runtime.ts` | `interface` | `HarnessRuntime`, `HarnessRuntimeOptions`, `HarnessExecutionEngine`, `HarnessRuntimeController` |
| `src/ports/resolution-context.ts` | `interface` | `ResolutionContext` |
| `src/ports/tool-effect.ts` | `interface` | `ToolEffect`, `LeaseDelta` |
| `src/ports/runner-driver.ts` | `interface` | `RunnerDriver` |
| `src/ports/tool-driver.ts` | `interface` | `ToolDriver<TNode, THandle>`, `ToolExecutionResult` |
| `src/ports/service-session.ts` | `interface` | `ServiceSession<THandle>` |
| `src/ports/reconcile-result.types.ts` | `type` | `ReconcileResult<TData>`, `ReconcileCleanResult<TData>`, `ReconcileConflictResult<TData>` |
| `src/ports/isolation-scope.ts` | `interface` | `IsolationScope<THandle, TReceipt>` |
| `src/ports/checkpointable-scope.ts` | `interface` | `CheckpointableScope<THandle, TReceipt>` |
| `src/ports/branchable-scope.ts` | `interface` | `BranchableScope<THandle, TReceipt, TSync>` |
| `src/ports/wire-frame-record.ts` | `interface` | `WireFrameRecord`, `CanonicalMessage`, `CanonicalToolCall`, `CanonicalToolResult` |
| `src/ports/compiled-wire-prefix.ts` | `interface` | `CompiledWirePrefix`, `WireToolSchema`, `GroundingSnapshotRecord` |
| `src/ports/fork-context.ts` | `interface` | `ForkContext`, `PrecedingCompletedToolResult` |
| `src/ports/model-driver.ts` | `interface` | `ModelDriver`, `ModelTurnRequest`, `ModelTurnResponse`, `ModelUsageMetrics`, `PrepareForkTarget`, `AppendToolResultNotesOptions` |
| `src/ports/universal-step-telemetry.ts` | `interface` | `UniversalStepTelemetry<TCustomMetrics, TAbortMeta>` |
| `src/ports/pending-tool-batch.ts` | `interface` | `PendingToolBatch`, `PendingPreFlightCall`, `RemainingToolCallRecord` |
| `src/ports/agent-pause-state.types.ts` | `type` | `AgentPauseState`, `ActiveTurnPauseState`, `ToolBatchPauseState`, `BeforeStopGatePauseState`, `AdjudicationPauseState`, `PrerequisiteWaitPauseState`, `InterruptFlushPauseState` |
| `src/ports/continuation-frame.types.ts` | `type` | `ContinuationFrame`, `AgentContinuationFrame`, `LoopContinuationFrame`, `ForkBatchContinuationFrame`, `ForkBatchEntryRecord`, `SpeculateContinuationFrame`, `SpeculateBranchEntryRecord` |
| `src/ports/suspended-fork-record.ts` | `interface` | `SuspendedForkRecord` |
| `src/ports/ledger-store.ts` | `interface` | `LedgerStore`, `CreateOrResumeRunInput`, `CreateOrResumeRunResult`, `RecordStepStartInput`, `MutateLanePlanRequest`, `RecordStepTransitionInput`, `InterruptedStepBootRecord` |
| `src/ports/topology-store.ts` | `interface` | `TopologyStore`, `TopologyPartitionState`, `CommitRunOverlayResult` |
| `src/ports/lesson-store.ts` | `interface` | `LessonStore`, `LessonRecord`, `DistilledLessonCandidate`, `LessonOutcome` |
| `src/ports/tracker-adapter.ts` | `interface` | `TrackerAdapter<TExternal, TExternalState>` |
| `src/ports/stream-source.ts` | `interface` | `StreamSource<TEvent>` |
| `src/ports/human-adapter.ts` | `interface` | `HumanAdapter`, `HumanDecisionRequest<TRequest, TResponse>` |
| `src/ports/control-plane-adapter.ts` | `interface` | `ControlPlaneAdapter` |

### 3.3 Schemas & Topology Layers (`packages/core/src/schemas/**`, `packages/core/src/topology/**`)

| File Path | Primary Category | Exported Symbols |
| :--- | :--- | :--- |
| `src/schemas/core-rules.schema.ts` | `schema` | `ScopePredicateSchema`, `ScopePredicate`, `GlobalRuleSchema`, `GlobalRule`, `ScopedRuleSchema`, `ScopedRule` |
| `src/schemas/budget-and-lesson.schema.ts` | `schema` | `BudgetApprovalSchema`, `BudgetApproval`, `DistilledLessonCandidateSchema`, `ResumeForkInputSchema`, `ResumeForkInput` |
| `src/schemas/speculation-schemas.ts` | `function` | `SpeculationCandidateSchema`, `SpeculationInputSchema` |
| `src/schemas/internal/convert-zod-def.ts` | `function` | `convertZodDefToJsonSchema`, `unwrapZodModifiers`, `convertObjectShape` |
| `src/schemas/zod-to-json-schema.ts` | `function` | `zodToJsonSchema(schema: z.ZodTypeAny): Readonly<Record<string, unknown>>` |
| `src/topology/internal/validate-topology-dag.ts` | `function` | `validateTopologyDAG`, `computeTransitiveDependents` |
| `src/topology/topology-queries.ts` | `function` | `dependentsOf<TPartition extends string>(topology: MaybeBuilder<TopologyNode<TPartition>>, partitionId: TPartition): readonly TPartition[]`, `affectedBy<TPartition extends string>(topology: MaybeBuilder<TopologyNode<TPartition>>, partitionId: TPartition): readonly TPartition[]` |

### 3.4 Fluent Builders Layer (`packages/core/src/builders/**`)

| File Path | Primary Category | Exported Symbols |
| :--- | :--- | :--- |
| `src/builders/internal/deep-freeze.ts` | `function` | `deepFreeze<T>(value: T): Readonly<T>`, `assertNonEmptyIdentifier(label: string, id: string): void`, `deriveCanonicalRoleKey(baseId: string, extraTools: readonly ToolASTNode<any>[]): string` |
| `src/builders/internal/validate-flow-capabilities.ts` | `function` | `validateFlowScopeCapabilities`, `validatePrefixGroupCloneTranscriptMode`, `validateBidirectionalHumanChannel` |
| `src/builders/signal-and-interrupt-builders.ts` | `function` | `createSignalBuilder`, `createInterruptBuilder`, `createStreamBuilder`, `StreamBuilder` |
| `src/builders/pool-and-prefix-builders.ts` | `function` | `createPoolBuilder`, `createPrefixGroupBuilder`, `PoolBuilder`, `PoolStrategyConfigurator`, `PrefixGroupBuilder` |
| `src/builders/topology-and-human-builders.ts` | `function` | `createTopologyBuilder`, `createHumanBuilder`, `HumanBuilder`, `ScopedHumanTargetBuilder` |
| `src/builders/rules-skill-and-lessons-builders.ts` | `function` | `createRulesBuilder`, `createScopedRuleBuilder`, `createSkillBuilder`, `createLessonsBuilder`, `RulesBuilder`, `ScopedRuleBuilder`, `SkillBuilder`, `LessonsBuilder` |
| `src/builders/policy-builder.ts` | `function` | `createPolicyBuilder`, `PolicyBuilder`, `PolicyGuardClausePendingBuilder`, `PolicyLimitExceededBuilder` |
| `src/builders/agent-capabilities-builder.ts` | `function` | `createAgentCapabilitiesBuilder`, `AgentCapabilitiesBuilder`, `ForkCapabilityBuilder`, `SpeculateCapabilityBuilder`, `MutatePlanCapabilityBuilder`, `EscalateCapabilityBuilder` |
| `src/builders/interrupt-edge-builders.ts` | `function` | `createInterruptEdgeBuilder`, `createChildInterruptBuilder`, `InterruptEdgeBuilder`, `ChildInterruptBuilder` |
| `src/builders/agent-and-command-builders.ts` | `function` | `createAgentBuilder`, `createCommandBuilder`, `AgentBuilder`, `CommandBuilder` |
| `src/builders/loop-builder.ts` | `function` | `createLoopBuilder`, `LoopBuilder` |
| `src/builders/flow-builder.ts` | `function` | `createFlowBuilder`, `FlowBuilder`, `FlowStepConfigBuilder`, `FlowBranchBuilder`, `FlowSubBranchBuilder` |
| `src/builders/lane-and-harness-builders.ts` | `function` | `createLaneBuilder`, `createHarnessBuilder`, `LaneBuilder`, `LaneTrackerBuilder`, `LaneRetryBuilder`, `LaneSignalHandlerBuilder`, `HarnessBuilder` |
| `src/builders/h-namespace.constants.ts` | `const` | `H: HarnessNamespace`, `HarnessNamespace` |
| `src/runtime/index.ts` | `barrel` | Pure explicit re-exports of `createExecutorRegistry` and runtime port types (` expanded in M2`) |
| `src/index.ts` | `barrel` | Pure explicit re-exports of `H`, `z`, `extractAST`, `dependentsOf`, `affectedBy`, `zodToJsonSchema`, `createExecutorRegistry`, all schemas, all builders, all port interfaces/types, and all `CoreASTNode` / `DomainASTNode` interfaces/types |

---

## 4. Detailed Implementation Requirements

### 4.1 Pure Passive Discriminated-Union AST & Hybrid Builder Objects (`SPEC.md` §1.2 & §2.1)
1. **Passive AST Invariant**: Every AST node returned by `.toAST()` is a deeply frozen plain object (`Object.freeze`) discriminated by `readonly type: '...'` with zero execution methods (`.execute`, `.run`, `.evaluate`, `.acquireRoot`, `.forkChild`, `.commitChild`, `.serializeCheckpoint`, `.poll`, `.ask`, `.start`, `.load`).
2. **Builder Ergonomics & Property Projection**:
   - Every builder implements `AstBuilder<TNode>` (`.toAST(): TNode`) and is copy-on-write immutable (each fluent method returns a new builder instance without mutating prior instances).
   - Composition methods across all builders accept `MaybeBuilder<TNode>` (`TNode | AstBuilder<TNode>`) and normalize via `extractAST`.
   - Builders also expose the compiled node's readonly properties directly on the frozen builder instance (such as `id`, `type`, `schema` on `SignalBuilder`/`InterruptBuilder`, `reportSchema` on `CrossVerifierBuilder`, and `dependentsOf`/`affectedBy` on `TopologyBuilder`) so expressions like `leaseRequest.schema`, `normativeEscalation.schema`, `contractViolation.schema`, `crossTester.reportSchema`, and `repoTopology.affectedBy(v.partition)` (`CODING_SAMPLE.md` lines `764, 787–788, 978`) work seamlessly with or without `.toAST()`.

### 4.2 Static Build-Time Validation Rules (`SPEC.md` §1.2, §3.5, §3.6, §3.7.2, §3.8, §3.9, §3.10)
1. **Topology DAG Validation (`H.topology(id).partitions(...)`)**:
   - Validates non-empty partition IDs, rejects unknown `dependsOn` partition IDs, and rejects self-loops or directed cycles via 3-state DFS (`unvisited`, `visiting`, `visited`) with an actionable `Error`.
   - `dependentsOf(topology, partitionId)` returns all strict transitive dependent partition IDs (`dependentsOf(repoTopology, 'db')` -> `['api', 'web']`).
   - `affectedBy(topology, partitionId)` returns `[partitionId, ...dependentsOf(topology, partitionId)]` (`affectedBy(repoTopology, 'db')` -> `['db', 'api', 'web']`).
2. **Capability Tier Validation on `H.flow` (`SPEC.md` §1.2 Invariant 1, §3.5, §3.7.2, §3.9)**:
   - Inspects `scopeNode.capabilityTier` (`'scope' | 'checkpointable' | 'branchable'`) statically at build time (never duck-typing runtime methods):
     - If any actor in `flow.nodes` declares `.fork()`, `.speculate()`, or `.mutatePlan()` with `spawnTasks` (`onPrerequisiteSpawned: 'suspend-and-yield-slot'`) or `canAddDependencies`, requires `scopeNode.capabilityTier === 'branchable'` (`supportsBranching: true`).
     - If any actor in `flow.nodes` mounts a `ToolASTNode` with `effectTracking === 'subprocess-post-flight'` alongside any `PolicyGuardASTNode`, or if any `.replaceWith()` edge omits `.onAbort()` on both the interrupt edge and the actor's `PolicyNode`, requires `scopeNode.capabilityTier === 'checkpointable' || scopeNode.capabilityTier === 'branchable'` (`supportsCheckpoints: true`).
3. **Prefix Group `'clone-transcript'` Validation (`SPEC.md` §3.2.1 & §3.7.2)**:
   - If an actor bound to `PrefixGroupNode` with `toolsMode === 'role-scoped'` configures `.fork(..., $f => $f.historyMode('clone-transcript'))` where the child actor has a distinct `roleKey`, throws an actionable build-time `Error` requiring `toolsMode('union')`.
4. **Human Channel `interactionMode` Validation (`SPEC.md` §1.2 Invariant 1 & §3.6)**:
   - Whenever an `H.human` node is bound to `.ask(human, schema)`, `.escalate(..., $esc => $esc.to(human)...)`, `human.withName(alias).output(schema)`, or `H.lane.maxCostUsd(limit, scopedHuman)`, statically verifies `human.channel.interactionMode === 'bidirectional'` (rejecting `'notify-only'` channels such as `SlackNotifierNode` at build time).
5. **Canonical `roleKey` Derivation on `.withTools()` and `.withPolicy()` (`SPEC.md` §3.2.1, §3.7.1, §3.8)**:
   - Base `H.agent(id)` initializes `roleKey = id`; base `H.loop(id).act(stepId, actor)` initializes `roleKey = actor.roleKey`.
   - `agent.withTools(...extraTools)` and `loop.withTools(...extraTools)` flatten `extraTools`, extract each tool's `name`, sort the extra tool names lexicographically, and set `roleKey = "${baseActorId}+tools:${sortedExtraToolNames.join(',')}"` (preserving order-independence across different argument orderings) while preserving `.prefixGroup()`, `.partitions()`, `.topology()`, all actor-level `.onInterrupt()` handlers, rules, skills, lessons, and `beforeStop` checks.
   - `agent.withPolicy(newPolicy)` and `loop.withPolicy(newPolicy)` preserve all actor-level `.onInterrupt()` handlers on the `.act()` actor while leaving `.evaluate()`'s `readOnlyPolicy` intact.
6. **Compile-Time & Build-Time Step ID Constraints (`SPEC.md` §3.8 & §3.10)**:
   - `H.loop.returnOutputFrom(actStepId: TActStepId)` constrains `actStepId` to the literal `TActStepId` passed to `.act(stepId, ...)` and verifies equality at build time.
   - `H.lane.onSignal(sig, $s => $s.update(mapper).rewindTo(stepId: TStepIds, ...))` constrains `stepId` to the literal `TStepIds` union of `flow` and verifies at build time that `stepId` exists in `flow.nodes`.

---

## 5. Deterministic Test Suite Architecture (`packages/core/test/**`)

All test files obey [`docs/CODING_GUIDELINES.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_GUIDELINES.md) §6 (`<= 400` lines per `*.test.ts` file, shared fixtures in `test/fixtures/**` `<= 250` lines with full JSDoc, exact structural assertions):

| File Path | Line Ceiling | Required Deterministic Test Cases |
| :--- | :--- | :--- |
| `test/fixtures/sample-domain-nodes.ts` | `<= 250` | Reusable passive `DomainASTNode` fixtures (`Tier1ScopeNode` with `capabilityTier: 'scope'`, `Tier2ScopeNode` with `capabilityTier: 'checkpointable'`, `Tier3ScopeNode` with `capabilityTier: 'branchable'`, `DeclaredToolNode`, `PostFlightSubprocessToolNode`, `SampleGuardNode`, `BidirectionalHumanChannelNode`, `NotifyOnlyHumanChannelNode`, `SampleModelNode`). |
| `test/ast-and-schemas.test.ts` | `<= 400` | 1. Verifies `extractAST`, `H.env(key)` symbolic `EnvRef` serialization (never reading `process.env`), `ScopePredicateSchema`, `GlobalRuleSchema`, `ScopedRuleSchema`, `BudgetApprovalSchema`, `ResumeForkInputSchema`, `SpeculationCandidateSchema`, and `SpeculationInputSchema` (including 5-argument invocation with union escalation schema from `CODING_SAMPLE.md` lines `783–789`).<br>2. Verifies `zodToJsonSchema` across primitives, literals, enums, arrays, tuples, records, nested objects with `.optional()` and `.default()`, discriminated unions, intersections, and deep-freeze invariants.<br>3. Verifies `CustomDomainASTRegistry` declaration merging (`CustomDomainAST<K>`). |
| `test/topology-and-builders.test.ts` | `<= 400` | 1. Verifies `H.topology` DAG validation (accepting valid `db <- api <- web` graph; rejecting unknown dependencies, self-cycles, and multi-node cycles with exact error messages).<br>2. Verifies `dependentsOf` (`'db' -> ['api', 'web']`, `'api' -> ['web']`, `'web' -> []`) and `affectedBy` (`'db' -> ['db', 'api', 'web']`) both as standalone functions and as methods on `TopologyBuilder`.<br>3. Verifies copy-on-write immutability, `.toAST()` deep-freeze, and all builder chains for `H.signal`, `H.interrupt`, `H.stream`, `H.pool` (`soonest-reset`, `round-robin`, `least-used`, `escalateOnRetry`, `custom`, `fallback`), `H.prefixGroup`, `H.rules`, `H.scopedRule`, `H.skill`, `H.lessons`, `H.policy` (including `.extend()`), `H.human`, `H.command` (verifying zero `.execute` method on `CommandNode`), `H.agent`, `H.loop`, and `createExecutorRegistry`.<br>4. Verifies `.withTools()` canonical order-independent `roleKey` (`"${baseActor.id}+tools:${sortedExtraToolNames.join(',')}"`) and `.withPolicy()` preservation of actor-level `.onInterrupt()` handlers. |
| `test/flow-and-validation.test.ts` | `<= 400` | 1. Verifies `H.flow` (`.step()`, `.branch()` with `.when()` / `.otherwise()`, `.inputFrom()`, `.onInterrupt()` adjudicate/ask/replace modes), `H.lane` (`.tracker()`, `.waitFor()`, `.maxCostUsd()`, `.retry()`, `.onSignal().rewindTo()`), and `H.harness`.<br>2. Verifies static build-time rejections: (a) `.fork()` / `.speculate()` / `.mutatePlan()` on a Tier-1 `'scope'` or Tier-2 `'checkpointable'` scope; (b) `effectTracking: 'subprocess-post-flight'` tool under a policy guard on a Tier-1 `'scope'` scope; (c) `.replaceWith()` without `.onAbort()` on a Tier-1 `'scope'` scope; (d) `'clone-transcript'` fork across distinct roles under `toolsMode: 'role-scoped'`; (e) `.ask()`, `.escalate()`, or `.maxCostUsd()` targeting a `'notify-only'` human channel; (f) invalid `.returnOutputFrom()` or `.rewindTo()` step IDs. |

---

## 6. Verification Gate Commands

Run from workspace root:

```bash
pnpm --filter @harness-dsl/core typecheck
pnpm --filter @harness-dsl/core test -- --reporter=verbose
test -z "$(git status --porcelain -- packages/sqlite/src packages/postgres/src packages/fs/src packages/markdown/src packages/node/src packages/git/src packages/claude/src packages/openai/src packages/gemini/src packages/github/src packages/slack/src packages/stripe/src packages/netsuite/src packages/integration/src)"
```
