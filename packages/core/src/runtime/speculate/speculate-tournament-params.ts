import type { AgentNode } from '../../ast/agent-node.js';
import type { StepASTNode } from '../../ast/domain-ast.types.js';
import type { SpeculateArbiterDecision } from '../../ast/speculate-arbiter-decision.types.js';
import type { SpeculateCapabilityNode } from '../../ast/speculate-capability-node.js';
import type { BranchableScope } from '../../ports/branchable-scope.js';
import type { CompiledWirePrefix } from '../../ports/compiled-wire-prefix.js';
import type { ContinuationFrame } from '../../ports/continuation-frame.types.js';
import type { HumanAdapter } from '../../ports/human-adapter.js';
import type { LedgerStore } from '../../ports/ledger-store.js';
import type { LessonStore } from '../../ports/lesson-store.js';
import type { ModelDriver } from '../../ports/model-driver.js';
import type {
  SpeculateBranchEntryRecord,
  SpeculateBufferedLessonOutcomeRecord,
  SpeculateContinuationFrame,
  SpeculateHumanRulingRecord,
} from '../../ports/speculate-continuation-frame.js';
import type { StepExecutionContext } from '../../ports/step-execution-context.js';
import type { ChildForkExecutionOutcome } from '../fork/fork-batch-execution-params.js';
import type { ScopeLockManager } from '../locks/scope-lock-manager.js';
import type { StepContinuationQueue } from '../locks/step-continuation-queue.js';

/**
 * Post-race classification computed by `resolvePostRaceCases()` (`SPEC.md` §3.7.2 Capability 2).
 *
 * Distinguishes Case 1 (`'all-failed'`), Case 2 (`'unpark-sole-escalated'`), Case 3 (`'sole-survivor'`),
 * and Case 4 (`'contested-arbitration'`).
 */
export interface PostRaceResolution {
  /** Post-race case discriminant. */
  readonly caseKind:
    | 'all-failed'
    | 'unpark-sole-escalated'
    | 'sole-survivor'
    | 'contested-arbitration';
  /** Target branch index for Case 2 (`'unpark-sole-escalated'`) or Case 3 (`'sole-survivor'`). */
  readonly targetBranchIndex?: number;
}

/**
 * Result returned by `runTournamentArbiterWithGate()` containing both the raw verdict and normalized decision.
 *
 * Guarantees that `decision` passed built-in `beforeStop` candidate index validation against `branches`.
 */
export interface ValidatedArbiterTurnResult {
  /** Raw structured verdict emitted by `arbiter.actor`. */
  readonly verdict: unknown;
  /** Normalized `SpeculateArbiterDecision` validated against surviving/parked branch indices. */
  readonly decision: SpeculateArbiterDecision;
}

/**
 * Context supplied to `unparkEscalatedTournamentBranch()` for unparking a single escalated branch.
 *
 * Carries the branch index, live child scope handle, and frame persistence callback.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 */
export interface UnparkBranchContext<THandle = unknown> {
  /** Zero-based index of the parked branch to unpark. */
  readonly branchIndex: number;
  /** Live child scope handle for the parked branch. */
  readonly handle: THandle;
  /** Callback persisting an updated `SpeculateContinuationFrame` into `LedgerStore`. */
  readonly persistFrame: (frame: SpeculateContinuationFrame) => Promise<void>;
}

/**
 * Outcome returned by `unparkEscalatedTournamentBranch()` after resolving or aborting a parked branch.
 *
 * Distinguishes exogenous human escalation resumption from upward child-interrupt abort.
 */
export interface UnparkBranchResult {
  /** Whether the parked branch resumed via human decision or aborted on an upward child interrupt. */
  readonly status: 'resumed' | 'aborted-on-child-interrupt';
  /** Updated `SpeculateContinuationFrame` after unparking. */
  readonly updatedFrame: SpeculateContinuationFrame;
  /** Optional serialized `ABORTED_ON_CHILD_INTERRUPT` tool result JSON. */
  readonly abortResultJson?: string;
}

/**
 * Context supplied to `executeWinnerRefinementAndCommit()` when committing the tournament winner.
 *
 * Carries the winning branch index, arbiter verdict, live candidate handles map, and persistence callback.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 */
export interface WinnerRefinementCommitContext<THandle = unknown> {
  /** Zero-based index of the winning candidate branch. */
  readonly winnerBranchIndex: number;
  /** Optional structured arbiter verdict passed to `refineWinnerWhen`. */
  readonly verdict: unknown;
  /** Map of all candidate branch indices to their live scope handles. */
  readonly handlesByBranch: ReadonlyMap<number, THandle>;
  /** Callback persisting an updated `SpeculateContinuationFrame` into `LedgerStore`. */
  readonly persistFrame: (frame: SpeculateContinuationFrame) => Promise<void>;
}

/**
 * Outcome returned by `executeSpeculateTournament()` for the parent assistant turn batch.
 *
 * Carries the serialized `tool_result` string, error status, and final `SpeculateContinuationFrame`.
 */
export interface SpeculateTournamentResult {
  /** Serialized `tool_result` JSON string returned to the parent agent. */
  readonly toolResultText: string;
  /** True when all branches failed or the arbiter rejected all candidates. */
  readonly isError: boolean;
  /** Final settled `SpeculateContinuationFrame`. */
  readonly tournamentFrame: SpeculateContinuationFrame;
}

/**
 * Parameters for executing a parallel `.speculate()` tournament (`SPEC.md` §3.7.2 Capability 2).
 *
 * Consolidates the `SpeculateCapabilityNode`, parent state, `BranchableScope`, `ScopeLockManager`,
 * `StepContinuationQueue`, `LedgerStore`, `LessonStore`, `HumanAdapter` map, and step runner callback.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 */
export interface SpeculateTournamentParams<THandle = unknown> {
  /** Parent `AgentNode` launching the tournament. */
  readonly parentNode: AgentNode<unknown, unknown, THandle>;
  /** Validated parent input payload. */
  readonly parentInput: unknown;
  /** Wire-level tool `callId` of the `.speculate()` invocation. */
  readonly callId: string;
  /** Matched `SpeculateCapabilityNode`. */
  readonly capability: SpeculateCapabilityNode<
    unknown,
    unknown,
    unknown,
    unknown,
    THandle,
    unknown,
    unknown
  >;
  /** Raw JSON arguments passed to the `.speculate()` tool call. */
  readonly argsJson: string;
  /** Outer continuation frames prefixing `SpeculateContinuationFrame`. */
  readonly outerFrames: readonly ContinuationFrame[];
  /** Optional existing `SpeculateContinuationFrame` when recovering mid-tournament. */
  readonly existingTournamentFrame?: SpeculateContinuationFrame;
  /** Active `BranchableScope` driver. */
  readonly branchableScope: BranchableScope<THandle, Record<string, unknown>, Record<string, unknown>>;
  /** Shared-read / exclusive-write lock manager for `parentHandle`. */
  readonly lockManager: ScopeLockManager;
  /** Per-`stepExecId` serialized continuation stack queue. */
  readonly continuationQueue: StepContinuationQueue;
  /** Durable `LedgerStore` instance. */
  readonly ledgerStore: LedgerStore;
  /** Optional `LessonStore` flushed strictly for the winning branch after `WINNER_COMMITTED`. */
  readonly lessonStore?: LessonStore;
  /** Optional `ModelDriver` used for conflict-bounce note injection. */
  readonly modelDriver?: ModelDriver;
  /** Optional pinned `CompiledWirePrefix`. */
  readonly wirePrefix?: CompiledWirePrefix;
  /** Map of `HumanAdapter` instances keyed by `humanNode.id` for `'unpark-escalation'`. */
  readonly humanAdaptersById?: ReadonlyMap<string, HumanAdapter>;
  /** Step execution context of the parent actor (`ctx.scopeHandle` is `parentHandle`). */
  readonly ctx: StepExecutionContext<THandle>;
  /** Callback executing a branch worker, sole-survivor evaluator, arbiter, or refinement step. */
  readonly executeChildStep: (
    childNode: StepASTNode<unknown, unknown, THandle>,
    childInput: unknown,
    childCtx: StepExecutionContext<THandle>,
  ) => Promise<ChildForkExecutionOutcome<unknown>>;
  /** Optional reference to post-race resolution for property reachability. */
  readonly postRaceTemplate?: PostRaceResolution;
  /** Optional reference to arbiter turn result for property reachability. */
  readonly arbiterResultTemplate?: ValidatedArbiterTurnResult;
  /** Optional reference to tournament result for property reachability. */
  readonly resultTemplate?: SpeculateTournamentResult;
  /** Optional reference to branch entry record for property reachability. */
  readonly branchEntryTemplate?: SpeculateBranchEntryRecord;
  /** Optional reference to buffered lesson outcome record for property reachability. */
  readonly bufferedLessonTemplate?: SpeculateBufferedLessonOutcomeRecord;
  /** Optional reference to human ruling record for property reachability. */
  readonly rulingTemplate?: SpeculateHumanRulingRecord;
  /** Optional reference to unpark branch context for property reachability. */
  readonly unparkContextTemplate?: UnparkBranchContext<THandle>;
  /** Optional reference to unpark branch result for property reachability. */
  readonly unparkResultTemplate?: UnparkBranchResult;
  /** Optional reference to winner commit context for property reachability. */
  readonly winnerCommitContextTemplate?: WinnerRefinementCommitContext<THandle>;
}
