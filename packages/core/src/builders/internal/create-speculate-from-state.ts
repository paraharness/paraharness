import type { z } from 'zod';
import type { AgentNode } from '../../ast/agent-node.js';
import type { MaybeBuilder } from '../../ast/ast-foundation.types.js';
import type { CrossVerifierASTNode } from '../../ast/domain-ast.types.js';
import { extractAST } from '../../ast/extract-ast.js';
import type { LoopNode } from '../../ast/loop-node.js';
import type { SpeculateArbiterDecision } from '../../ast/speculate-arbiter-decision.types.js';
import type { SpeculateCapabilityNode } from '../../ast/speculate-capability-node.js';
import type { ExtractSpeculationCandidate } from '../flow-extraction.types.js';
import type { SpeculateCapabilityBuilder } from '../speculate-capability-builder.js';
import { deepFreeze } from './deep-freeze.js';
import type { SpeculateCapabilityState } from './speculate-capability-state.js';

/**
 * Creates an immutable `SpeculateCapabilityBuilder` from an internal state snapshot.
 *
 * Configures speculative N-branch tournaments including request schema validation,
 * worker executables, branch mappers, optional cross-verifiers, sole-survivor verifiers,
 * arbiters, and conditional winner refinement.
 *
 * @template TParentIn    Parent actor input payload type.
 * @template TReq         Validated speculation tool request payload type.
 * @template TChildIn     Branch worker input payload type.
 * @template TChildOut    Branch worker output payload type.
 * @template THandle      Isolation scope handle type.
 * @template TCrossReport Cross-verifier report payload type.
 * @template TVerdict     Arbiter structured verdict output type.
 * @template TCandidate   Candidate union element type.
 *
 * @param {SpeculateCapabilityState<TParentIn, TReq, TChildIn, TChildOut, THandle, TCrossReport, TVerdict>} state - Internal builder state.
 *
 * @returns {SpeculateCapabilityBuilder<TParentIn, TReq, TChildIn, TChildOut, THandle, TCrossReport, TVerdict, TCandidate>} Frozen speculate builder.
 */
export function createSpeculateFromState<
  TParentIn = unknown, TReq = unknown, TChildIn = unknown, TChildOut = unknown,
  THandle = unknown, TCrossReport = unknown, TVerdict = unknown, TCandidate = unknown,
>(
  state: SpeculateCapabilityState<TParentIn, TReq, TChildIn, TChildOut, THandle, TCrossReport, TVerdict>,
): SpeculateCapabilityBuilder<TParentIn, TReq, TChildIn, TChildOut, THandle, TCrossReport, TVerdict, TCandidate> {
  return Object.freeze<SpeculateCapabilityBuilder<TParentIn, TReq, TChildIn, TChildOut, THandle, TCrossReport, TVerdict, TCandidate>>({
    requestSchema: <TNewReq>(schema: z.ZodType<TNewReq>) =>
      createSpeculateFromState<TParentIn, TNewReq, TChildIn, TChildOut, THandle, TCrossReport, TVerdict, TCandidate>({ ...state, requestSchema: schema, mapBranches: undefined }),
    worker: <TNewChildIn, TNewChildOut>(
      workerExecutable: MaybeBuilder<AgentNode<TNewChildIn, TNewChildOut, THandle> | LoopNode<TNewChildIn, TNewChildOut, THandle, string>>,
    ) =>
      createSpeculateFromState<TParentIn, TReq, TNewChildIn, TNewChildOut, THandle, TCrossReport, TVerdict, TCandidate>({
        ...state,
        workerExecutable: extractAST(workerExecutable),
        mapBranches: undefined,
        verifyWinnerWith: undefined,
        refineWinnerWhen: undefined,
      }),
    branches: (branchCount: number, mapBranches: (parentInput: TParentIn, req: TReq) => readonly TChildIn[]) => {
      if (!Number.isInteger(branchCount) || branchCount < 2) {
        throw new Error(`Speculate capability '${state.toolName}' requires branchCount >= 2 (received ${branchCount}).`);
      }
      return createSpeculateFromState<TParentIn, TReq, TChildIn, TChildOut, THandle, TCrossReport, TVerdict, TCandidate>({ ...state, branchCount, mapBranches });
    },
    crossVerifyWith: <TNewCrossReport>(
      crossVerifier: MaybeBuilder<CrossVerifierASTNode<THandle, Record<string, unknown>, TNewCrossReport>>,
    ) => createSpeculateFromState<TParentIn, TReq, TChildIn, TChildOut, THandle, TNewCrossReport, TVerdict, TCandidate>({ ...state, crossVerifier: extractAST(crossVerifier) }),
    verifyWinnerWith: <
      TEvalIn,
      TEvalOut,
      TReceipt = TCandidate extends { readonly scopeReceipt: infer R } ? R : unknown,
    >(
      evaluator: MaybeBuilder<AgentNode<TEvalIn, TEvalOut, THandle>>,
      verifyOptions: {
        readonly mapInput: (branchInput: TChildIn, branchOutput: TChildOut, scopeReceipt: TReceipt) => TEvalIn;
        readonly acceptWhen: (evalOut: TEvalOut) => boolean;
      },
    ) =>
      createSpeculateFromState<TParentIn, TReq, TChildIn, TChildOut, THandle, TCrossReport, TVerdict, TCandidate>({
        ...state,
        verifyWinnerWith: { evaluator: extractAST(evaluator), mapInput: verifyOptions.mapInput, acceptWhen: verifyOptions.acceptWhen },
      }),
    arbiter: <TNewVerdict, TArbiterIn = unknown>(
      arbiterActor: MaybeBuilder<AgentNode<TArbiterIn, TNewVerdict, THandle>>,
      arbiterOptions?: { readonly resolveDecision?: (verdict: TNewVerdict) => SpeculateArbiterDecision },
    ) =>
      createSpeculateFromState<TParentIn, TReq, TChildIn, TChildOut, THandle, TCrossReport, TNewVerdict, ExtractSpeculationCandidate<TArbiterIn>>({
        ...state,
        arbiter: {
          actor: extractAST(arbiterActor),
          resolveDecision:
            arbiterOptions?.resolveDecision ??
            ((verdict: TNewVerdict): SpeculateArbiterDecision => verdict as SpeculateArbiterDecision),
        },
        refineWinnerWhen: undefined,
      }),
    refineWinnerWhen: (
      predicate: (verdict: TVerdict) => boolean,
      refinementExecutable: MaybeBuilder<AgentNode<TChildIn, TChildOut, THandle> | LoopNode<TChildIn, TChildOut, THandle, string>>,
      mapInput: (parentInput: TParentIn, verdict: TVerdict, candidates: readonly TCandidate[]) => TChildIn,
    ) => createSpeculateFromState<TParentIn, TReq, TChildIn, TChildOut, THandle, TCrossReport, TVerdict, TCandidate>({ ...state, refineWinnerWhen: { predicate, refinementExecutable: extractAST(refinementExecutable), mapInput } }),
    toAST: (): SpeculateCapabilityNode<TParentIn, TReq, TChildIn, TChildOut, THandle, TCrossReport, TVerdict> => {
      if (state.requestSchema === undefined || state.workerExecutable === undefined || state.branchCount === undefined || state.mapBranches === undefined || state.arbiter === undefined) {
        throw new Error(`Speculate capability '${state.toolName}' is missing required .requestSchema(), .worker(), .branches(), or .arbiter() configuration.`);
      }
      return deepFreeze<SpeculateCapabilityNode<TParentIn, TReq, TChildIn, TChildOut, THandle, TCrossReport, TVerdict>>({
        type: 'harness:speculate-capability',
        toolName: state.toolName,
        requestSchema: state.requestSchema,
        workerExecutable: state.workerExecutable,
        branchCount: state.branchCount,
        mapBranches: state.mapBranches,
        crossVerifier: state.crossVerifier,
        verifyWinnerWith: state.verifyWinnerWith,
        arbiter: state.arbiter,
        refineWinnerWhen: state.refineWinnerWhen,
      });
    },
  });
}
