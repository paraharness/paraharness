import type { BivariantCallback } from '../ast/ast-foundation.types.js';
import type {
  AbortHookASTNode, CheckASTNode, ControlPlaneASTNode, CrossVerifierASTNode,
  DomainStepASTNode, EffectMatcherASTNode, HumanChannelASTNode, IsolationScopeASTNode,
  LedgerStoreASTNode, LessonStoreASTNode, ModelASTNode, PolicyGuardASTNode,
  QuotaTripwireASTNode, RunnerPoolASTNode, ScopeRewindHookASTNode, ServiceASTNode,
  SourceASTNode, StreamSourceASTNode, TelemetryCollectorASTNode, ToolASTNode,
  TopologyStoreASTNode, TrackerASTNode,
} from '../ast/domain-ast.types.js';
import type { BranchableScope } from './branchable-scope.js';
import type { CheckpointableScope } from './checkpointable-scope.js';
import type { ControlPlaneAdapter } from './control-plane-adapter.js';
import type { HumanAdapter } from './human-adapter.js';
import type { IsolationScope } from './isolation-scope.js';
import type { LeaseDelta } from './lease-delta.js';
import type { LedgerStore } from './ledger-store.js';
import type { LessonStore } from './lesson-store.js';
import type { ModelDriver } from './model-driver.js';
import type { NodeExecutorMap } from './node-executor.types.js';
import type { ResolutionContext } from './resolution-context.js';
import type { RunnerDriver } from './runner-driver.js';
import type { RuntimeDriverContext } from './runtime-driver-context.js';
import type { ServiceSession } from './service-session.js';
import type { StepExecutionContext } from './step-execution-context.js';
import type { StreamSource } from './stream-source.js';
import type { ToolDriver } from './tool-driver.js';
import type { ToolEffect } from './tool-effect.js';
import type { TopologyStore } from './topology-store.js';
import type { TrackerAdapter } from './tracker-adapter.js';

export type { RuntimeExecutorRegistrySlice } from './runtime-executor-registry-slice.js';

/**
 * Resolved artifact returned by a `SourceASTNode` executor in `RuntimeExecutorRegistry.sources`.
 *
 * Pairs the loaded source content with its SHA-256 hex digest for deterministic prefix and grounding tracking.
 *
 * @template TContent Resolved source content type.
 */
export interface ResolvedSourceArtifact<TContent = unknown> {
  /** Parsed or raw content loaded from the source. */
  readonly content: TContent;
  /** Cryptographic SHA-256 hex digest of the resolved content. */
  readonly digest: string;
}

/**
 * Verification result returned by a `CheckASTNode` executor in `RuntimeExecutorRegistry.checks`.
 *
 * Indicates whether the deterministic check passed and provides actionable deficit strings when rejected.
 */
export interface CheckEvaluationResult {
  /** True when the deterministic check passed with zero deficits. */
  readonly ok: boolean;
  /** Actionable deficit descriptions when `ok` is `false`. */
  readonly deficits: readonly string[];
}

/**
 * Input payload supplied to an `AbortHookASTNode` executor in `RuntimeExecutorRegistry.abortHooks`.
 *
 * Carries the active scope handle and run/step execution coordinates during `.replaceWith()` cleanup.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface AbortHookExecutionInput<THandle = unknown> {
  /** Active isolation scope handle being aborted. */
  readonly handle: THandle;
  /** Unique identifier of the enclosing harness run. */
  readonly runId: string;
  /** Unique execution identifier of the aborted step. */
  readonly stepExecId: string;
}

/**
 * Input payload supplied to a `ScopeRewindHookASTNode` executor in `RuntimeExecutorRegistry.rewindHooks`.
 *
 * Carries the active scope handle and optional target-step base checkpoint during `.rewindTo()` transitions.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface RewindHookExecutionInput<THandle = unknown> {
  /** Active isolation scope handle being rewound. */
  readonly handle: THandle;
  /** Optional base scope checkpoint recorded when the target step originally started. */
  readonly targetStepBaseScopeCheckpoint?: string;
}

/**
 * Candidate branch descriptor supplied to a `CrossVerifierASTNode` executor in `RuntimeExecutorRegistry.crossVerifiers`.
 *
 * Pairs each surviving speculative branch index with its live scope handle and inspected receipt.
 *
 * @template THandle Runtime handle type of the candidate branch's isolation scope.
 */
export interface CrossVerifierBranchCandidate<THandle = unknown> {
  /** Zero-based speculative branch index. */
  readonly branchIndex: number;
  /** Live isolation scope handle for the candidate branch. */
  readonly scopeHandle: THandle;
  /** Inspected scope receipt for the candidate branch. */
  readonly scopeReceipt: Record<string, unknown>;
}

/**
 * Input payload supplied to a `ServiceASTNode` executor in `RuntimeExecutorRegistry.services`.
 *
 * Identifies the run, canonical scope key, and scope handle where the background daemon is mounted.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface ServiceStartInput<THandle = unknown> {
  /** Unique identifier of the enclosing harness run. */
  readonly runId: string;
  /** Canonical scope key of the isolation scope mounting the service. */
  readonly scopeKey: string;
  /** Active isolation scope handle. */
  readonly scopeHandle: THandle;
}

/**
 * Input payload supplied to a `PolicyGuardASTNode` executor in `RuntimeExecutorRegistry.policyGuards`.
 *
 * Provides the invoked tool name, proposed pre-flight or post-flight effects, and currently active leases.
 */
export interface PolicyGuardEvaluationInput {
  /** Name of the tool being evaluated. */
  readonly toolName: string;
  /** Pre-flight or post-flight tool effects proposed by the tool invocation. */
  readonly proposedEffects: readonly ToolEffect[];
  /** Capability lease deltas currently active on the actor or enclosing loop. */
  readonly activeLeases: readonly LeaseDelta[];
}

/**
 * Result returned by a `PolicyGuardASTNode` executor in `RuntimeExecutorRegistry.policyGuards`.
 *
 * Reports whether the proposed tool effects are permitted and lists any uncovered violated effects.
 */
export interface PolicyGuardEvaluationResult {
  /** True when all proposed effects are permitted by this guard or covered by an active lease. */
  readonly allowed: boolean;
  /** Subset of proposed effects that violated the guard and were not covered by any active lease. */
  readonly violatedEffects: readonly ToolEffect[];
  /** Human- and model-readable explanation of the policy violation. */
  readonly violationSummary: string;
}

/**
 * Input payload supplied to a `QuotaTripwireASTNode` executor in `RuntimeExecutorRegistry.quotaTripwires`.
 *
 * Separates previously accumulated step effects from newly observed tool effects for incremental evaluation.
 */
export interface QuotaTripwireEvaluationInput {
  /** Cumulative tool effects recorded prior to the current tool invocation. */
  readonly accumulatedEffects: readonly ToolEffect[];
  /** Newly recorded tool effects from the current tool invocation. */
  readonly newEffects: readonly ToolEffect[];
}

/**
 * Result returned by a `QuotaTripwireASTNode` executor in `RuntimeExecutorRegistry.quotaTripwires`.
 *
 * Indicates whether a quantitative effect quota was breached and provides a diagnostic reason string.
 */
export interface QuotaTripwireEvaluationResult {
  /** True when the cumulative effects exceed the tripwire's quantitative threshold. */
  readonly tripped: boolean;
  /** Optional diagnostic reason explaining which threshold was breached. */
  readonly reason?: string;
}

/**
 * Complete runtime lookup table mapping every `DomainASTNode` category and `type` discriminant to its executor or driver factory.
 *
 * Assembled via `createExecutorRegistry(...slices)` and injected into `createRuntime(harness, { registry })`.
 */
export interface RuntimeExecutorRegistry {
  /** Stateless executors for domain step AST nodes (`DomainStepASTNode`). */
  readonly steps: NodeExecutorMap<DomainStepASTNode, unknown, unknown, StepExecutionContext<unknown>>;
  /** Stateless executors for grounding, rule, and skill source AST nodes (`SourceASTNode`). */
  readonly sources: NodeExecutorMap<SourceASTNode, void, ResolvedSourceArtifact, ResolutionContext>;
  /** Stateless executors for deterministic check AST nodes (`CheckASTNode`). */
  readonly checks: NodeExecutorMap<CheckASTNode, void, CheckEvaluationResult, StepExecutionContext<unknown>>;
  /** Stateless executors for scope abort hook AST nodes (`AbortHookASTNode`). */
  readonly abortHooks: NodeExecutorMap<AbortHookASTNode, AbortHookExecutionInput, Record<string, unknown>, StepExecutionContext<unknown>>;
  /** Stateless executors for scope rewind hook AST nodes (`ScopeRewindHookASTNode`). */
  readonly rewindHooks: NodeExecutorMap<ScopeRewindHookASTNode, RewindHookExecutionInput, void, StepExecutionContext<unknown>>;
  /** Stateless executors for speculative cross-verifier AST nodes (`CrossVerifierASTNode`). */
  readonly crossVerifiers: NodeExecutorMap<CrossVerifierASTNode, ReadonlyArray<CrossVerifierBranchCandidate>, Readonly<Record<number, unknown>>, StepExecutionContext<unknown>>;
  /** Stateless factories for background daemon service sessions (`ServiceASTNode`). */
  readonly services: NodeExecutorMap<ServiceASTNode, ServiceStartInput, ServiceSession<unknown>, RuntimeDriverContext>;
  /** Stateless evaluators for policy guard AST nodes (`PolicyGuardASTNode`). */
  readonly policyGuards: NodeExecutorMap<PolicyGuardASTNode, PolicyGuardEvaluationInput, PolicyGuardEvaluationResult, StepExecutionContext<unknown>>;
  /** Stateless evaluators for quantitative quota tripwire AST nodes (`QuotaTripwireASTNode`). */
  readonly quotaTripwires: NodeExecutorMap<QuotaTripwireASTNode, QuotaTripwireEvaluationInput, QuotaTripwireEvaluationResult, StepExecutionContext<unknown>>;
  /** Stateless collectors that fold observed `ToolEffect` lists into custom telemetry metrics (`TelemetryCollectorASTNode`). */
  readonly telemetryCollectors: NodeExecutorMap<TelemetryCollectorASTNode, readonly ToolEffect[], Record<string, unknown>, StepExecutionContext<unknown>>;
  /** Stateless predicates that test whether a `ToolEffect` is covered by a granted `EffectMatcherASTNode` lease. */
  readonly effectMatchers: NodeExecutorMap<EffectMatcherASTNode, ToolEffect, boolean, StepExecutionContext<unknown>>;
  /** Tool drivers indexed by `ToolASTNode['type']`. */
  readonly tools: { readonly [TNode in ToolASTNode as TNode['type']]?: ToolDriver<TNode, unknown> };
  /** Runner pool driver factories indexed by `RunnerPoolASTNode['type']`. */
  readonly runners: { readonly [TNode in RunnerPoolASTNode as TNode['type']]?: BivariantCallback<[node: TNode], RunnerDriver> };
  /** Isolation scope driver factories indexed by `IsolationScopeASTNode['type']`. */
  readonly scopes: {
    readonly [TNode in IsolationScopeASTNode as TNode['type']]?: BivariantCallback<
      [node: TNode, ctx: RuntimeDriverContext],
      | IsolationScope<unknown, Record<string, unknown>>
      | CheckpointableScope<unknown, Record<string, unknown>>
      | BranchableScope<unknown, Record<string, unknown>, Record<string, unknown>>
    >;
  };
  /** Model driver factories indexed by `ModelASTNode['type']`. */
  readonly models: { readonly [TNode in ModelASTNode as TNode['type']]?: BivariantCallback<[node: TNode, ctx: RuntimeDriverContext], ModelDriver> };
  /** Ledger store driver factories indexed by `LedgerStoreASTNode['type']`. */
  readonly ledgers: { readonly [TNode in LedgerStoreASTNode as TNode['type']]?: BivariantCallback<[node: TNode, ctx: RuntimeDriverContext], LedgerStore> };
  /** Topology store driver factories indexed by `TopologyStoreASTNode['type']`. */
  readonly topologies: { readonly [TNode in TopologyStoreASTNode as TNode['type']]?: BivariantCallback<[node: TNode, ctx: RuntimeDriverContext], TopologyStore> };
  /** Lesson store driver factories indexed by `LessonStoreASTNode['type']`. */
  readonly lessons: { readonly [TNode in LessonStoreASTNode as TNode['type']]?: BivariantCallback<[node: TNode, ctx: RuntimeDriverContext], LessonStore> };
  /** External issue tracker adapter factories indexed by `TrackerASTNode['type']`. */
  readonly trackers: { readonly [TNode in TrackerASTNode as TNode['type']]?: BivariantCallback<[node: TNode, ctx: RuntimeDriverContext], TrackerAdapter<unknown, string>> };
  /** Inbound event stream source factories indexed by `StreamSourceASTNode['type']`. */
  readonly streamSources: { readonly [TNode in StreamSourceASTNode as TNode['type']]?: BivariantCallback<[node: TNode, ctx: RuntimeDriverContext], StreamSource<unknown>> };
  /** Human channel adapter factories indexed by `HumanChannelASTNode['type']`. */
  readonly humanChannels: { readonly [TNode in HumanChannelASTNode as TNode['type']]?: BivariantCallback<[node: TNode, ctx: RuntimeDriverContext], HumanAdapter> };
  /** Control-plane adapter factories indexed by `ControlPlaneASTNode['type']`. */
  readonly controlPlanes: { readonly [TNode in ControlPlaneASTNode as TNode['type']]?: BivariantCallback<[node: TNode, ctx: RuntimeDriverContext], ControlPlaneAdapter> };
}
