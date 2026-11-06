import type { z } from 'zod';
import type { AgentNode } from './agent-node.js';
import type { BivariantCallback } from './ast-foundation.types.js';
import type { CrossVerifierASTNode } from './domain-ast.types.js';
import type { LoopNode } from './loop-node.js';
import type { SpeculateArbiterDecision } from './speculate-arbiter-decision.types.js';

/**
 * Optional sole-survivor verification gate (`verifyWinnerWith`) for uncontested speculative tournaments.
 *
 * Invokes `evaluator` when exactly one branch completes and zero branches are parked, avoiding
 * full multi-candidate arbitration while still verifying the sole surviving branch.
 *
 * @template TChildIn  Branch worker input payload type.
 * @template TChildOut Branch worker output payload type.
 * @template THandle   Runtime handle type of the active `BranchableScope`.
 * @template TReceipt  Inspected scope receipt type.
 * @template TEvalOut  Evaluator output payload type.
 */
export interface SpeculateVerifyWinnerConfig<
  TChildIn = unknown,
  TChildOut = unknown,
  THandle = unknown,
  TReceipt = unknown,
  TEvalOut = unknown,
> {
  /** Read-only evaluator agent invoked on an uncontested sole survivor before committing. */
  readonly evaluator: AgentNode<unknown, TEvalOut, THandle>;
  /** Synchronous mapper constructing the evaluator's input from `(branchInput, branchOutput, scopeReceipt)`. */
  readonly mapInput: BivariantCallback<
    [branchInput: TChildIn, branchOutput: TChildOut, scopeReceipt: TReceipt],
    unknown
  >;
  /** Predicate returning `true` when the evaluator accepts the sole surviving branch. */
  readonly acceptWhen: BivariantCallback<[evalOut: TEvalOut], boolean>;
}

/**
 * Arbiter configuration (`arbiter`) for judging multiple completed or parked speculative branches.
 *
 * Dispatches the read-only `actor` agent over the tournament's `SpeculationInputSchema` payload
 * and normalizes its structured `TVerdict` via `resolveDecision`.
 *
 * @template THandle  Runtime handle type of the active `BranchableScope`.
 * @template TVerdict Structured verdict output type of the arbiter agent.
 */
export interface SpeculateArbiterConfig<THandle = unknown, TVerdict = unknown> {
  /** Read-only arbiter agent invoked over `SpeculationInputSchema` candidates. */
  readonly actor: AgentNode<unknown, TVerdict, THandle>;
  /** Pure synchronous projector normalizing the arbiter's `TVerdict` into a `SpeculateArbiterDecision`. */
  readonly resolveDecision: BivariantCallback<[verdict: TVerdict], SpeculateArbiterDecision>;
}

/**
 * Optional post-arbitration refinement step (`refineWinnerWhen`) for synthesizing cross-candidate improvements on the winning branch.
 *
 * Runs `refinementExecutable` on the winning branch scope while keeping losing candidate branches
 * mounted read-only for `git.candidateComparisonTools` inspection before final tournament teardown.
 *
 * @template TParentIn  Parent actor input payload type.
 * @template TChildIn   Branch worker input payload type.
 * @template TChildOut  Branch worker output payload type.
 * @template THandle    Runtime handle type of the active `BranchableScope`.
 * @template TVerdict   Structured verdict output type of the arbiter agent.
 * @template TCandidate Candidate record type passed to `mapInput`.
 */
export interface SpeculateRefineWinnerConfig<
  TParentIn = unknown,
  TChildIn = unknown,
  TChildOut = unknown,
  THandle = unknown,
  TVerdict = unknown,
  TCandidate = unknown,
> {
  /** Predicate testing whether the arbiter's verdict requests post-selection refinement. */
  readonly predicate: BivariantCallback<[verdict: TVerdict], boolean>;
  /** Agent or loop executable invoked on the winning branch handle while losing branch handles remain readable. */
  readonly refinementExecutable:
    | AgentNode<TChildIn, TChildOut, THandle>
    | LoopNode<TChildIn, TChildOut, THandle, string>;
  /** Synchronous mapper constructing the refinement executable's input from `(parentInput, verdict, candidates)`. */
  readonly mapInput: BivariantCallback<
    [parentInput: TParentIn, verdict: TVerdict, candidates: readonly TCandidate[]],
    TChildIn
  >;
}

/**
 * Passive AST node representing a parallel speculative tournament capability (`$cap.speculate(toolName, $s => ...)`).
 *
 * Forks $B$ isolated branch scopes in parallel, executes `workerExecutable` across `mapBranches`,
 * runs `crossVerifier`, arbitrates or verifies the winner, and optionally refines the winning branch before committing.
 *
 * @template TParentIn    Parent actor input payload type.
 * @template TReq         Validated speculation tool request payload type.
 * @template TChildIn     Branch worker input payload type.
 * @template TChildOut    Branch worker output payload type.
 * @template THandle      Runtime handle type of the active `BranchableScope`.
 * @template TCrossReport Cross-verifier report payload type.
 * @template TVerdict     Arbiter agent structured verdict payload type.
 */
export interface SpeculateCapabilityNode<
  TParentIn = unknown,
  TReq = unknown,
  TChildIn = unknown,
  TChildOut = unknown,
  THandle = unknown,
  TCrossReport = unknown,
  TVerdict = unknown,
> {
  /** Discriminant identifying a speculative tournament capability AST node. */
  readonly type: 'harness:speculate-capability';
  /** Tool name exposed to the parent agent for launching the tournament. */
  readonly toolName: string;
  /** Zod schema validating the parent agent's speculation tool call arguments. */
  readonly requestSchema: z.ZodType<TReq, z.ZodTypeDef, unknown>;
  /** Worker agent or loop executed in parallel across all $B$ tournament branches. */
  readonly workerExecutable:
    | AgentNode<TChildIn, TChildOut, THandle>
    | LoopNode<TChildIn, TChildOut, THandle, string>;
  /** Number of parallel speculative branches $B \ge 2$. */
  readonly branchCount: number;
  /** Synchronous mapper producing $B$ branch inputs from `(parentInput, req)`. */
  readonly mapBranches: BivariantCallback<[parentInput: TParentIn, req: TReq], readonly TChildIn[]>;
  /** Optional cross-verifier AST node executed across surviving candidate branches before arbitration. */
  readonly crossVerifier?: CrossVerifierASTNode<THandle, Record<string, unknown>, TCrossReport>;
  /** Optional sole-survivor evaluator configuration when 1 branch completes uncontested. */
  readonly verifyWinnerWith?: SpeculateVerifyWinnerConfig<TChildIn, TChildOut, THandle>;
  /** Arbiter agent and decision resolver invoked on contested or multi-survivor tournaments. */
  readonly arbiter: SpeculateArbiterConfig<THandle, TVerdict>;
  /** Optional post-arbitration winner refinement configuration. */
  readonly refineWinnerWhen?: SpeculateRefineWinnerConfig<
    TParentIn,
    TChildIn,
    TChildOut,
    THandle,
    TVerdict
  >;
}
