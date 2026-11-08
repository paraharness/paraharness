import type { AgentNode } from '../../ast/agent-node.js';
import type { ModelASTNode, StepASTNode, ToolASTNode } from '../../ast/domain-ast.types.js';
import type { EscalateCapabilityNode } from '../../ast/escalate-capability-node.js';
import type { ForkCapabilityNode } from '../../ast/fork-capability-node.js';
import type { InlineScopedRuleNode } from '../../ast/inline-scoped-rule-node.js';
import type { InlineSkillNode } from '../../ast/inline-skill-node.js';
import type { InterruptNode } from '../../ast/interrupt-node.js';
import type { SpeculateCapabilityNode } from '../../ast/speculate-capability-node.js';
import type { AgentContinuationFrame } from '../../ports/agent-continuation-frame.js';
import type { CompiledWirePrefix } from '../../ports/compiled-wire-prefix.js';
import type { ContinuationFrame } from '../../ports/continuation-frame.types.js';
import type { HumanAdapter } from '../../ports/human-adapter.js';
import type { LedgerStore } from '../../ports/ledger-store.js';
import type { LessonOutcome } from '../../ports/lesson-outcome.types.js';
import type { LessonStore } from '../../ports/lesson-store.js';
import type { RecalledLoopLessonRecord } from '../../ports/loop-continuation-frame.js';
import type { ModelDriver } from '../../ports/model-driver.js';
import type { StepExecutionContext } from '../../ports/step-execution-context.js';
import type { TopologyStore } from '../../ports/topology-store.js';
import type { ChildForkExecutionOutcome } from '../fork/child-fork-execution-outcome.js';
import type { ScopeLockManager } from '../locks/scope-lock-manager.js';
import type { StepContinuationQueue } from '../locks/step-continuation-queue.js';
import type { PoolManager } from '../pools/pool-manager.js';
import type { ServiceSessionRegistry } from '../services/service-session-registry.js';

/**
 * Mutable session state passed across `P.agent` turn-loop phase functions (`Rule 3.1` — zero closure state machines).
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
  /** Map of skill-unlocked tool or service tool name to its owning `skill.id` for pre-flight skill lease gating. */
  readonly skillOwnerByToolName: ReadonlyMap<string, string>;
  /** Map of service tool name to its owning `serviceNode.id` for `ServiceSession.invokeTool` dispatch. */
  readonly serviceByToolName?: ReadonlyMap<string, string>;
  /** Resolved actor-specific `.grounding()` text blocks. */
  readonly actorGroundingTexts?: readonly string[];
  /** Resolved actor-specific `.instructions()` text blocks. */
  readonly actorInstructionTexts?: readonly string[];
  /** Resolved `InlineScopedRuleNode` definitions mounted on `node.rules`. */
  readonly scopedRules: readonly InlineScopedRuleNode[];
  /** Pre-indexed map of all always-on and skill-unlocked `ToolASTNode` definitions by `tool.name`. */
  readonly toolsByName: ReadonlyMap<string, ToolASTNode<THandle>>;
  /** Pre-indexed map of `.fork()` capability descriptors keyed by `toolName`. */
  readonly forksByToolName: ReadonlyMap<
    string,
    ForkCapabilityNode<TIn, unknown, unknown, unknown, THandle>
  >;
  /** Pre-indexed map of `.speculate()` capability descriptors keyed by `toolName`. */
  readonly speculationsByToolName: ReadonlyMap<
    string,
    SpeculateCapabilityNode<TIn, unknown, unknown, unknown, THandle, unknown, unknown>
  >;
  /** Pre-indexed map of `.escalate()` capability descriptors keyed by `interrupt.id`. */
  readonly escalationsByInterruptId: ReadonlyMap<string, EscalateCapabilityNode<unknown, unknown>>;
  /** Pre-indexed map of `.canRaise()` voluntary interrupt descriptors keyed by `interrupt.id`. */
  readonly canRaiseInterruptsById: ReadonlyMap<string, InterruptNode<unknown>>;
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
  /** Optional phantom reference to `TOut` so the generic parameter is structurally used. */
  readonly outputTypeMarker?: TOut;
}
