import type { IsolationScopeASTNode, RunnerPoolASTNode } from '../ast/domain-ast.types.js';
import type { EnvRef } from '../ast/env-ref.js';
import type { BranchableScope } from './branchable-scope.js';
import type { CheckpointableScope } from './checkpointable-scope.js';
import type { ContinuationFrame } from './continuation-frame.types.js';
import type { IsolationScope } from './isolation-scope.js';
import type { LeaseDelta } from './lease-delta.js';
import type { RunnerDriver } from './runner-driver.js';
import type { ServiceSession } from './service-session.js';
import type { ToolEffect } from './tool-effect.js';
import type { WireFrameRecord } from './wire-frame-record.js';

/**
 * Step-level execution context carrying isolation scope handles, leases, observed effects, and environment resolution.
 *
 * Passed to step executors, checks, policy guards, tripwires, and hooks during flow execution.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface ExecutionContext<THandle = unknown> {
  /** Unique identifier of the enclosing harness run. */
  readonly runId: string;
  /** Unique execution identifier of the active step invocation. */
  readonly stepExecId: string;
  /** Active isolation scope handle for the current step or branch. */
  readonly scopeHandle: THandle;
  /** Optional passive AST node of the active isolation scope. */
  readonly scopeNode?: IsolationScopeASTNode<THandle, Record<string, unknown>, Record<string, unknown>>;
  /** Optional active isolation scope runtime driver instance. */
  readonly scope?:
    | IsolationScope<THandle, Record<string, unknown>>
    | CheckpointableScope<THandle, Record<string, unknown>>
    | BranchableScope<THandle, Record<string, unknown>, Record<string, unknown>>;
  /** Optional map of surviving speculative candidate branch indices to their live scope handles. */
  readonly candidateHandles?: ReadonlyMap<number, THandle>;
  /** Optional map of active background daemon service sessions keyed by service ID. */
  readonly activeServiceSessions?: ReadonlyMap<string, ServiceSession<THandle>>;
  /** Partition identifiers unlocked for the active step. */
  readonly activePartitions: readonly string[];
  /** Capability lease deltas currently granted to the active actor or loop. */
  readonly activeLeases: readonly LeaseDelta[];
  /** Tool effects observed so far within the active step execution. */
  readonly observedEffects: readonly ToolEffect[];
  /** Optional cancellation signal for aborting in-flight operations. */
  readonly signal?: AbortSignal;
  /** Optional pre-seeded wire transcript frames inherited from a parent or aborted fast-path attempt. */
  readonly seededHistory?: readonly WireFrameRecord[];
  /** Optional continuation frame stack used when resuming a suspended or interrupted step. */
  readonly resumeContinuationStack?: readonly ContinuationFrame[];

  /**
   * Resolves a literal string or symbolic `M.env(key)` reference against the runtime environment map.
   *
   * Returns literal strings unchanged and looks up `EnvRef.key` in the explicit runtime `env` record.
   *
   * @param {string | EnvRef} value - Literal string or symbolic environment variable reference.
   *
   * @returns {string | undefined} Resolved environment variable value, or `undefined` if unset.
   */
  resolveEnv(value: string | EnvRef): string | undefined;

  /**
   * Returns the runtime's memoized `RunnerDriver` instance keyed by `node.id`.
   *
   * Instantiates the runner driver on first access via `RuntimeExecutorRegistry.runners[node.type]` and caches it per `node.id`.
   *
   * @param {RunnerPoolASTNode} node - Passive runner pool AST node.
   *
   * @returns {RunnerDriver} Memoized runner driver instance.
   */
  getRunner(node: RunnerPoolASTNode): RunnerDriver;

  /**
   * Appends newly observed tool effects to the active step's effect log and telemetry collector.
   *
   * Triggers incremental quota tripwire checks and records effect attributes for step telemetry folding.
   *
   * @param {readonly ToolEffect[]} effects - Tool effects emitted by a tool execution or post-flight diff.
   */
  recordEffects(effects: readonly ToolEffect[]): void;
}
