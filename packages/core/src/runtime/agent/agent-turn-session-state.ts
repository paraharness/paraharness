import type { AgentNode } from '../../ast/agent-node.js';
import type { ModelASTNode, StepASTNode, ToolASTNode } from '../../ast/domain-ast.types.js';
import type { InlineScopedRuleNode } from '../../ast/inline-scoped-rule-node.js';
import type { InlineSkillNode } from '../../ast/inline-skill-node.js';
import type { InterruptHandlerNode } from '../../ast/interrupt-handler-node.types.js';
import type { AgentContinuationFrame } from '../../ports/agent-continuation-frame.js';
import type { CompiledWirePrefix } from '../../ports/compiled-wire-prefix.js';
import type { ContinuationFrame } from '../../ports/continuation-frame.types.js';
import type { HumanAdapter } from '../../ports/human-adapter.js';
import type { LeaseDelta } from '../../ports/lease-delta.js';
import type { LedgerStore } from '../../ports/ledger-store.js';
import type { LessonOutcome } from '../../ports/lesson-outcome.types.js';
import type { LessonStore } from '../../ports/lesson-store.js';
import type { RecalledLoopLessonRecord } from '../../ports/loop-continuation-frame.js';
import type { ModelDriver } from '../../ports/model-driver.js';
import type { PendingToolBatch, RemainingToolCallRecord } from '../../ports/pending-tool-batch.js';
import type { StepExecutionContext } from '../../ports/step-execution-context.js';
import type { TopologyStore } from '../../ports/topology-store.js';
import type { ChildForkExecutionOutcome } from '../fork/fork-batch-execution-params.js';
import type { ScopeLockManager } from '../locks/scope-lock-manager.js';
import type { StepContinuationQueue } from '../locks/step-continuation-queue.js';
import type { PoolManager } from '../pools/pool-manager.js';
import type { ServiceSessionRegistry } from '../services/service-session-registry.js';

/**
 * Outcome returned by `evaluateBeforeStopGate()` when an agent emits a completion turn (`SPEC.md` §3.4.1 & §3.7.1).
 *
 * Indicates whether all `beforeStop` checks, scoped rule checks, `conflictCleanCheck`, and open-fork gates passed.
 */
export interface BeforeStopGateEvaluationResult {
  /** True when all deterministic `beforeStop` checks passed with zero deficits. */
  readonly passed: boolean;
  /** Actionable deficit messages injected back into the transcript when `passed` is `false`. */
  readonly deficits: readonly string[];
  /** Identifiers of checks that failed during this gate evaluation. */
  readonly failedCheckIds: readonly string[];
}

/**
 * Outcome returned by `resolveInterruptEdge()` when handling a policy, voluntary, or child interrupt (`SPEC.md` §3.5 & §3.6).
 *
 * Distinguishes in-band resumption (`status: 'resumed'`), step replacement (`status: 'replace'`),
 * and upward propagation (`status: 'unhandled'`).
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface InterruptEdgeResolution<THandle = unknown> {
  /** Resolution status of the interrupt edge. */
  readonly status: 'resumed' | 'replace' | 'unhandled';
  /** Feedback string returned by `.resumeWith(...)` when `status === 'resumed'`. */
  readonly feedback?: string;
  /** Capability leases granted by `.elevateLeaseWhen(...)` during adjudication. */
  readonly grantedLeases: readonly LeaseDelta[];
  /** Matched `.replaceWith(...)` handler when `status === 'replace'`. */
  readonly replaceHandler?: InterruptHandlerNode<unknown, unknown, THandle>;
  /** Raised interrupt identifier. */
  readonly interruptId: string;
  /** Validated interrupt payload. */
  readonly payload: unknown;
}

/**
 * Outcome returned by `drainPendingToolBatch()` after processing `PendingToolBatch.remainingCalls`.
 *
 * Reports whether the batch completed normally (`'completed'`), suspended on prerequisites (`'suspended'`),
 * or exited via an unhandled/replacement interrupt (`'interrupted'`).
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface DrainToolBatchOutcome<THandle = unknown> {
  /** Terminal status of the tool batch drain. */
  readonly status: 'completed' | 'suspended' | 'interrupted';
  /** Settled `PendingToolBatch` record. */
  readonly batch: PendingToolBatch;
  /** Interrupt resolution metadata when `status === 'interrupted'`. */
  readonly interruptResolution?: InterruptEdgeResolution<THandle>;
}

/**
 * Mutable session state passed across `H.agent` turn-loop phase functions (`Rule 3.1` — zero closure state machines).
 *
 * Encapsulates the passive `AgentNode`, validated input, current `AgentContinuationFrame`, outer continuation
 * frames, pre-indexed tool/skill/rule tables, runtime managers, and stores.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface AgentTurnSessionState<TIn = unknown, TOut = unknown, THandle = unknown> {
  /** Passive `AgentNode` being executed. */
  readonly node: AgentNode<TIn, TOut, THandle>;
  /** Schema-validated input payload for the agent session. */
  readonly validatedInput: TIn;
  /** Active step execution context. */
  readonly ctx: StepExecutionContext<THandle>;
  /** Current mutable reference to the session's `AgentContinuationFrame`. */
  agentFrame: AgentContinuationFrame;
  /** Outer continuation frames (`loop-frame`, etc.) prefixing `agentFrame`. */
  readonly outerFrames: ContinuationFrame[];
  /** Pre-indexed map of resolved `InlineSkillNode` definitions keyed by `skill.id`. */
  readonly skillsById: ReadonlyMap<string, InlineSkillNode<THandle>>;
  /** Map of skill-unlocked tool name to its owning `skill.id` for pre-flight skill lease gating. */
  readonly skillOwnerByToolName: ReadonlyMap<string, string>;
  /** Resolved `InlineScopedRuleNode` definitions mounted on `node.rules`. */
  readonly scopedRules: readonly InlineScopedRuleNode[];
  /** Pre-indexed map of all always-on and skill-unlocked `ToolASTNode` definitions by `tool.name`. */
  readonly toolsByName: ReadonlyMap<string, ToolASTNode<THandle>>;
  /** Selected `ModelASTNode` for the current turn. */
  modelNode: ModelASTNode;
  /** Active `ModelDriver` instance for `modelNode`. */
  modelDriver: ModelDriver;
  /** Optional pinned `CompiledWirePrefix` for `node.prefixGroup`. */
  readonly wirePrefix?: CompiledWirePrefix;
  /** Optional durable `LedgerStore`. */
  readonly ledgerStore?: LedgerStore;
  /** Optional `TopologyStore`. */
  readonly topologyStore?: TopologyStore;
  /** Optional `LessonStore`. */
  readonly lessonStore?: LessonStore;
  /** Shared-read / exclusive-write scope lock manager. */
  readonly lockManager: ScopeLockManager;
  /** Serialized per-`stepExecId` continuation stack queue. */
  readonly continuationQueue: StepContinuationQueue;
  /** Capacity pool manager for model and account seat selection. */
  readonly poolManager: PoolManager;
  /** Reference-counted `ServiceSessionRegistry` for skill daemons. */
  readonly serviceRegistry: ServiceSessionRegistry;
  /** Map of `HumanAdapter` instances keyed by `humanNode.id`. */
  readonly humanAdaptersById: ReadonlyMap<string, HumanAdapter>;
  /** Active lessons recalled at session or loop start. */
  readonly recalledLessons: readonly RecalledLoopLessonRecord[];
  /** Mutable deduplicated `lessonId -> LessonOutcome` map for the current session. */
  readonly accumulatedLessonOutcomes: Record<string, LessonOutcome>;
  /** Optional enclosing lane ID for `.mutatePlan()`. */
  readonly laneId?: string;
  /** Optional enclosing work item key for `.mutatePlan()`. */
  readonly itemKey?: string;
  /** Optional base scope checkpoint captured at step start. */
  readonly baseScopeCheckpoint?: string;
  /** Number of tasks spawned so far in this run via `spawnTasks`. */
  spawnedTasksCount: number;
  /** Most recent spawned task key ($T_{\text{prevTip}}$) for linear prerequisite chaining. */
  previousSpawnedTipKey?: string;
  /** Callback executing a child `StepASTNode` (adjudicator, fork child, or speculative worker). */
  readonly executeChildStep: (
    childNode: StepASTNode<unknown, unknown, THandle>,
    childInput: unknown,
    childCtx: StepExecutionContext<THandle>,
  ) => Promise<ChildForkExecutionOutcome<unknown>>;
  /** Optional reference to gate result for property reachability. */
  readonly gateResultTemplate?: BeforeStopGateEvaluationResult;
  /** Optional reference to interrupt resolution for property reachability. */
  readonly interruptResolutionTemplate?: InterruptEdgeResolution<THandle>;
  /** Optional reference to drain outcome for property reachability. */
  readonly drainOutcomeTemplate?: DrainToolBatchOutcome<THandle>;
  /** Optional reference to remaining call record for property reachability. */
  readonly remainingCallTemplate?: RemainingToolCallRecord;
  /** Optional phantom reference to `TOut` so the generic parameter is structurally used. */
  readonly outputTypeMarker?: TOut;
}
