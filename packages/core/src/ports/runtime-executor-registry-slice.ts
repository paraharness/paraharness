import type { RuntimeExecutorRegistry } from './runtime-executor-registry.js';

/**
 * Partial slice of `RuntimeExecutorRegistry` exported by an individual domain adapter package.
 *
 * Allows each `@paraharness/*` adapter package to register only its own AST node executors
 * and combine them via `createExecutorRegistry(...slices)`.
 */
export interface RuntimeExecutorRegistrySlice {
  /** Optional partial map of domain step executors (`DomainStepASTNode`). */
  readonly steps?: Partial<RuntimeExecutorRegistry['steps']>;
  /** Optional partial map of grounding, rule, and skill source executors (`SourceASTNode`). */
  readonly sources?: Partial<RuntimeExecutorRegistry['sources']>;
  /** Optional partial map of deterministic check executors (`CheckASTNode`). */
  readonly checks?: Partial<RuntimeExecutorRegistry['checks']>;
  /** Optional partial map of scope abort hook executors (`AbortHookASTNode`). */
  readonly abortHooks?: Partial<RuntimeExecutorRegistry['abortHooks']>;
  /** Optional partial map of scope rewind hook executors (`ScopeRewindHookASTNode`). */
  readonly rewindHooks?: Partial<RuntimeExecutorRegistry['rewindHooks']>;
  /** Optional partial map of speculative cross-verifier executors (`CrossVerifierASTNode`). */
  readonly crossVerifiers?: Partial<RuntimeExecutorRegistry['crossVerifiers']>;
  /** Optional partial map of background daemon service factories (`ServiceASTNode`). */
  readonly services?: Partial<RuntimeExecutorRegistry['services']>;
  /** Optional partial map of policy guard evaluators (`PolicyGuardASTNode`). */
  readonly policyGuards?: Partial<RuntimeExecutorRegistry['policyGuards']>;
  /** Optional partial map of quantitative quota tripwire evaluators (`QuotaTripwireASTNode`). */
  readonly quotaTripwires?: Partial<RuntimeExecutorRegistry['quotaTripwires']>;
  /** Optional partial map of custom telemetry collectors (`TelemetryCollectorASTNode`). */
  readonly telemetryCollectors?: Partial<RuntimeExecutorRegistry['telemetryCollectors']>;
  /** Optional partial map of capability lease effect matchers (`EffectMatcherASTNode`). */
  readonly effectMatchers?: Partial<RuntimeExecutorRegistry['effectMatchers']>;
  /** Optional partial map of tool drivers (`ToolASTNode`). */
  readonly tools?: Partial<RuntimeExecutorRegistry['tools']>;
  /** Optional partial map of runner pool driver factories (`RunnerPoolASTNode`). */
  readonly runners?: Partial<RuntimeExecutorRegistry['runners']>;
  /** Optional partial map of isolation scope driver factories (`IsolationScopeASTNode`). */
  readonly scopes?: Partial<RuntimeExecutorRegistry['scopes']>;
  /** Optional partial map of model driver factories (`ModelASTNode`). */
  readonly models?: Partial<RuntimeExecutorRegistry['models']>;
  /** Optional partial map of ledger store driver factories (`LedgerStoreASTNode`). */
  readonly ledgers?: Partial<RuntimeExecutorRegistry['ledgers']>;
  /** Optional partial map of topology store driver factories (`TopologyStoreASTNode`). */
  readonly topologies?: Partial<RuntimeExecutorRegistry['topologies']>;
  /** Optional partial map of lesson store driver factories (`LessonStoreASTNode`). */
  readonly lessons?: Partial<RuntimeExecutorRegistry['lessons']>;
  /** Optional partial map of external issue tracker adapter factories (`TrackerASTNode`). */
  readonly trackers?: Partial<RuntimeExecutorRegistry['trackers']>;
  /** Optional partial map of inbound event stream source factories (`StreamSourceASTNode`). */
  readonly streamSources?: Partial<RuntimeExecutorRegistry['streamSources']>;
  /** Optional partial map of human channel adapter factories (`HumanChannelASTNode`). */
  readonly humanChannels?: Partial<RuntimeExecutorRegistry['humanChannels']>;
  /** Optional partial map of control-plane adapter factories (`ControlPlaneASTNode`). */
  readonly controlPlanes?: Partial<RuntimeExecutorRegistry['controlPlanes']>;
}
