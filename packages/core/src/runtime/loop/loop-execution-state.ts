import type { ModelASTNode } from '../../ast/domain-ast.types.js';
import type { LoopNode } from '../../ast/loop-node.js';
import type { CompiledWirePrefix } from '../../ports/compiled-wire-prefix.js';
import type { ContinuationFrame } from '../../ports/continuation-frame.types.js';
import type { HumanAdapter } from '../../ports/human-adapter.js';
import type { LedgerStore } from '../../ports/ledger-store.js';
import type { LessonOutcome } from '../../ports/lesson-outcome.types.js';
import type { LessonStore } from '../../ports/lesson-store.js';
import type { LoopContinuationFrame } from '../../ports/loop-continuation-frame.js';
import type { StepExecutionContext } from '../../ports/step-execution-context.js';
import type { TopologyStore } from '../../ports/topology-store.js';
import type { ScopeLockManager } from '../locks/scope-lock-manager.js';
import type { StepContinuationQueue } from '../locks/step-continuation-queue.js';
import type { PoolManager } from '../pools/pool-manager.js';
import type { ServiceSessionRegistry } from '../services/service-session-registry.js';

/**
 * Mutable execution state passed across `M.loop` iteration phase helpers (`Rule 3.1`).
 *
 * Tracks the active `LoopContinuationFrame`, outer continuation frames, model escalation state,
 * deduplicated lesson outcomes, and runtime managers.
 *
 * @template TIn     Validated loop input payload type.
 * @template TOut    Validated loop output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface LoopExecutionState<TIn = unknown, TOut = unknown, THandle = unknown> {
  /** Passive `LoopNode` AST definition. */
  readonly node: LoopNode<TIn, TOut, THandle>;
  /** Schema-validated loop input payload. */
  readonly validatedInput: TIn;
  /** Active step execution context. */
  readonly ctx: StepExecutionContext<THandle>;
  /** Mutable current `LoopContinuationFrame` state. */
  loopFrame: LoopContinuationFrame;
  /** Outer continuation frames prefixing `loopFrame`. */
  readonly outerFrames: ContinuationFrame[];
  /** Deduplicated per-lesson 4-state outcome map accumulated across the loop. */
  readonly accumulatedLessonOutcomes: Record<string, LessonOutcome>;
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
  /** Capacity pool manager for model and seat selection. */
  readonly poolManager: PoolManager;
  /** Reference-counted `ServiceSessionRegistry`. */
  readonly serviceRegistry: ServiceSessionRegistry;
  /** Map of `HumanAdapter` instances keyed by `humanNode.id`. */
  readonly humanAdaptersById: ReadonlyMap<string, HumanAdapter>;
  /** Map of compiled wire prefixes keyed by `prefixGroup.id`. */
  readonly wirePrefixesByGroupId: ReadonlyMap<string, CompiledWirePrefix>;
  /** Currently selected `ModelASTNode` for the `.act()` actor. */
  currentActModelNode: ModelASTNode;
  /** Most recent inner `.act()` `ContinuationFrame` captured on exit or interruption. */
  lastInnerAgentFrame?: ContinuationFrame;
  /** Tool call ID at which the inner `.act()` agent suspended, if any. */
  lastSuspendedAtCallId?: string;
  /** Optional phantom reference to `TOut` so the generic parameter is structurally used. */
  readonly outputTypeMarker?: TOut;
}
