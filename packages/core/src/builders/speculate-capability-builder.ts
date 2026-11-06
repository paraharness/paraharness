import type { z } from 'zod';
import type { AgentNode } from '../ast/agent-node.js';
import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type { AstBuilder } from '../ast/ast-builder.js';
import type { CrossVerifierASTNode } from '../ast/domain-ast.types.js';
import type { LoopNode } from '../ast/loop-node.js';
import type { SpeculateArbiterDecision } from '../ast/speculate-arbiter-decision.types.js';
import type { SpeculateCapabilityNode } from '../ast/speculate-capability-node.js';
import type { ExtractSpeculationCandidate } from './flow-extraction.types.js';

/**
 * Fluent sub-builder for a parallel speculative tournament capability (`$cap.speculate(toolName, $s => ...)`).
 *
 * Configures $B \ge 2$ isolated tournament branches, optional cross-branch verification,
 * sole-survivor verification, arbiter judgment, and conditional post-arbitration refinement.
 *
 * @template TParentIn    Parent actor input payload type.
 * @template TReq         Validated speculation tool request payload type.
 * @template TChildIn     Branch worker input payload type.
 * @template TChildOut    Branch worker output payload type.
 * @template THandle      Runtime handle type of the active `BranchableScope`.
 * @template TCrossReport Cross-verifier report payload type.
 * @template TVerdict     Arbiter agent structured verdict payload type.
 * @template TCandidate   Candidate union element type inferred from the arbiter's input schema.
 */
export interface SpeculateCapabilityBuilder<
  TParentIn = unknown,
  TReq = unknown,
  TChildIn = unknown,
  TChildOut = unknown,
  THandle = unknown,
  TCrossReport = unknown,
  TVerdict = unknown,
  TCandidate = unknown,
> extends AstBuilder<
    SpeculateCapabilityNode<TParentIn, TReq, TChildIn, TChildOut, THandle, TCrossReport, TVerdict>
  > {
  /**
   * Binds the Zod validation schema for the parent agent's speculation tool call arguments.
   *
   * Resets any previously bound `mapBranches` callback when the request schema changes.
   *
   * @template TNewReq Validated speculation request payload type.
   *
   * @param {z.ZodType<TNewReq, z.ZodTypeDef, unknown>} schema - Zod schema for the speculation request.
   *
   * @returns {SpeculateCapabilityBuilder<TParentIn, TNewReq, TChildIn, TChildOut, THandle, TCrossReport, TVerdict, TCandidate>} New immutable speculate builder.
   */
  requestSchema<TNewReq>(
    schema: z.ZodType<TNewReq, z.ZodTypeDef, unknown>,
  ): SpeculateCapabilityBuilder<
    TParentIn,
    TNewReq,
    TChildIn,
    TChildOut,
    THandle,
    TCrossReport,
    TVerdict,
    TCandidate
  >;

  /**
   * Binds the worker agent or loop executed in parallel across all tournament branches.
   *
   * Resets dependent branch mapper, sole-survivor verifier, and winner refinement configs when changed.
   *
   * @template TNewChildIn  Branch worker input payload type.
   * @template TNewChildOut Branch worker output payload type.
   *
   * @param {MaybeBuilder<AgentNode<TNewChildIn, TNewChildOut, THandle> | LoopNode<TNewChildIn, TNewChildOut, THandle, string>>} workerExecutable - Worker agent or loop.
   *
   * @returns {SpeculateCapabilityBuilder<TParentIn, TReq, TNewChildIn, TNewChildOut, THandle, TCrossReport, TVerdict, TCandidate>} New immutable speculate builder.
   */
  worker<TNewChildIn, TNewChildOut>(
    workerExecutable: MaybeBuilder<
      | AgentNode<TNewChildIn, TNewChildOut, THandle>
      | LoopNode<TNewChildIn, TNewChildOut, THandle, string>
    >,
  ): SpeculateCapabilityBuilder<
    TParentIn,
    TReq,
    TNewChildIn,
    TNewChildOut,
    THandle,
    TCrossReport,
    TVerdict,
    TCandidate
  >;

  /**
   * Configures the number of parallel speculative branches ($B \ge 2$) and the branch input mapper.
   *
   * Throws immediately at builder call time if `branchCount < 2` or is not an integer.
   *
   * @param {number}                                                     branchCount - Number of parallel branches ($B \ge 2$).
   * @param {(parentInput: TParentIn, req: TReq) => readonly TChildIn[]} mapBranches - Synchronous mapper producing $B$ branch inputs.
   *
   * @returns {SpeculateCapabilityBuilder<TParentIn, TReq, TChildIn, TChildOut, THandle, TCrossReport, TVerdict, TCandidate>} New immutable speculate builder.
   */
  branches(
    branchCount: number,
    mapBranches: (parentInput: TParentIn, req: TReq) => readonly TChildIn[],
  ): SpeculateCapabilityBuilder<
    TParentIn,
    TReq,
    TChildIn,
    TChildOut,
    THandle,
    TCrossReport,
    TVerdict,
    TCandidate
  >;

  /**
   * Binds an optional cross-verifier AST node executed across surviving candidate branches before arbitration.
   *
   * Narrows `TCrossReport` to the report type produced by `crossVerifier`.
   *
   * @template TNewCrossReport Cross-verifier report payload type.
   *
   * @param {MaybeBuilder<CrossVerifierASTNode<THandle, Record<string, unknown>, TNewCrossReport>>} crossVerifier - Cross-verifier node or builder.
   *
   * @returns {SpeculateCapabilityBuilder<TParentIn, TReq, TChildIn, TChildOut, THandle, TNewCrossReport, TVerdict, TCandidate>} New immutable speculate builder.
   */
  crossVerifyWith<TNewCrossReport>(
    crossVerifier: MaybeBuilder<CrossVerifierASTNode<THandle, Record<string, unknown>, TNewCrossReport>>,
  ): SpeculateCapabilityBuilder<TParentIn, TReq, TChildIn, TChildOut, THandle, TNewCrossReport, TVerdict, TCandidate>;

  /**
   * Configures an optional sole-survivor evaluator invoked when 1 branch completes uncontested.
   *
   * Short-circuits the arbiter when the sole completed branch is accepted by `options.acceptWhen`.
   *
   * @template TEvalOut Evaluator output payload type.
   * @template TReceipt Inspected scope receipt type.
   *
   * @param {MaybeBuilder<AgentNode<unknown, TEvalOut, THandle>>}                                                                                                             evaluator - Read-only evaluator agent.
   * @param {{ readonly mapInput: (branchInput: TChildIn, branchOutput: TChildOut, scopeReceipt: TReceipt) => unknown; readonly acceptWhen: (evalOut: TEvalOut) => boolean }} options   - Input mapper and acceptance predicate.
   *
   * @returns {SpeculateCapabilityBuilder<TParentIn, TReq, TChildIn, TChildOut, THandle, TCrossReport, TVerdict, TCandidate>} New immutable speculate builder.
   */
  verifyWinnerWith<TEvalOut, TReceipt = unknown>(
    evaluator: MaybeBuilder<AgentNode<unknown, TEvalOut, THandle>>,
    options: {
      readonly mapInput: (branchInput: TChildIn, branchOutput: TChildOut, scopeReceipt: TReceipt) => unknown;
      readonly acceptWhen: (evalOut: TEvalOut) => boolean;
    },
  ): SpeculateCapabilityBuilder<TParentIn, TReq, TChildIn, TChildOut, THandle, TCrossReport, TVerdict, TCandidate>;

  /**
   * Binds the read-only arbiter agent and decision projector for judging candidate branches.
   *
   * Infers `TCandidate` from `TArbiterIn` so `.refineWinnerWhen(...)` receives typed candidates.
   *
   * @template TNewVerdict Arbiter structured verdict output type.
   * @template TArbiterIn  Arbiter input payload type (used to infer `TCandidate`).
   *
   * @param {MaybeBuilder<AgentNode<TArbiterIn, TNewVerdict, THandle>>}                        arbiterActor - Read-only arbiter agent.
   * @param {{ readonly resolveDecision: (verdict: TNewVerdict) => SpeculateArbiterDecision }} options      - Pure decision projector.
   *
   * @returns {SpeculateCapabilityBuilder<TParentIn, TReq, TChildIn, TChildOut, THandle, TCrossReport, TNewVerdict, ExtractSpeculationCandidate<TArbiterIn>>} New immutable speculate builder.
   */
  arbiter<TNewVerdict, TArbiterIn = unknown>(
    arbiterActor: MaybeBuilder<AgentNode<TArbiterIn, TNewVerdict, THandle>>,
    options: { readonly resolveDecision: (verdict: TNewVerdict) => SpeculateArbiterDecision },
  ): SpeculateCapabilityBuilder<TParentIn, TReq, TChildIn, TChildOut, THandle, TCrossReport, TNewVerdict, ExtractSpeculationCandidate<TArbiterIn>>;

  /**
   * Configures an optional post-arbitration refinement pass executed on the winning branch while losing branches remain readable.
   *
   * Runs `refinementExecutable` on the winning branch's isolated scope before merging into the parent scope.
   *
   * @param {(verdict: TVerdict) => boolean}                                                                         predicate            - Predicate testing whether refinement should run.
   * @param {MaybeBuilder<AgentNode<TChildIn, TChildOut, THandle> | LoopNode<TChildIn, TChildOut, THandle, string>>} refinementExecutable - Refinement agent or loop.
   * @param {(parentInput: TParentIn, verdict: TVerdict, candidates: readonly TCandidate[]) => TChildIn}             mapInput             - Refinement input mapper.
   *
   * @returns {SpeculateCapabilityBuilder<TParentIn, TReq, TChildIn, TChildOut, THandle, TCrossReport, TVerdict, TCandidate>} New immutable speculate builder.
   */
  refineWinnerWhen(
    predicate: (verdict: TVerdict) => boolean,
    refinementExecutable: MaybeBuilder<AgentNode<TChildIn, TChildOut, THandle> | LoopNode<TChildIn, TChildOut, THandle, string>>,
    mapInput: (parentInput: TParentIn, verdict: TVerdict, candidates: readonly TCandidate[]) => TChildIn,
  ): SpeculateCapabilityBuilder<TParentIn, TReq, TChildIn, TChildOut, THandle, TCrossReport, TVerdict, TCandidate>;
}
