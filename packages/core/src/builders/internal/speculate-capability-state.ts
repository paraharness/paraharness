import type { z } from 'zod';
import type { AgentNode } from '../../ast/agent-node.js';
import type { BivariantCallback } from '../../ast/ast-foundation.types.js';
import type { CrossVerifierASTNode } from '../../ast/domain-ast.types.js';
import type { LoopNode } from '../../ast/loop-node.js';
import type {
  SpeculateArbiterConfig,
  SpeculateRefineWinnerConfig,
  SpeculateVerifyWinnerConfig,
} from '../../ast/speculate-capability-node.js';

/**
 * Immutable copy-on-write state snapshot backing `SpeculateCapabilityBuilder`.
 *
 * Captures the tournament tool name, request schema, parallel branch worker, branch count,
 * cross-verifier, sole-survivor verifier, arbiter configuration, and post-selection refinement rule.
 *
 * @template TParentIn    Parent actor input payload type.
 * @template TReq         Validated speculation tool request payload type.
 * @template TChildIn     Branch worker input payload type.
 * @template TChildOut    Branch worker output payload type.
 * @template THandle      Runtime handle type of the active `BranchableScope`.
 * @template TCrossReport Cross-verifier report payload type.
 * @template TVerdict     Arbiter structured verdict output payload type.
 */
export interface SpeculateCapabilityState<
  TParentIn = unknown,
  TReq = unknown,
  TChildIn = unknown,
  TChildOut = unknown,
  THandle = unknown,
  TCrossReport = unknown,
  TVerdict = unknown,
> {
  /** Tool name exposed to the parent agent for launching the tournament. */
  readonly toolName: string;
  /** Zod schema validating the parent agent's speculation tool call arguments. */
  readonly requestSchema?: z.ZodType<TReq, z.ZodTypeDef, unknown>;
  /** Worker agent or loop executed in parallel across all tournament branches. */
  readonly workerExecutable?:
    | AgentNode<TChildIn, TChildOut, THandle>
    | LoopNode<TChildIn, TChildOut, THandle, string>;
  /** Number of parallel speculative branches ($B \ge 2$). */
  readonly branchCount?: number;
  /** Synchronous mapper producing $B$ branch inputs from `(parentInput, req)`. */
  readonly mapBranches?: BivariantCallback<
    [parentInput: TParentIn, req: TReq],
    readonly TChildIn[]
  >;
  /** Optional cross-verifier AST node executed across surviving branches before arbitration. */
  readonly crossVerifier?: CrossVerifierASTNode<THandle, Record<string, unknown>, TCrossReport>;
  /** Optional sole-survivor evaluator configuration when 1 branch completes uncontested. */
  readonly verifyWinnerWith?: SpeculateVerifyWinnerConfig<TChildIn, TChildOut, THandle>;
  /** Arbiter agent and decision projector for judging contested candidate branches. */
  readonly arbiter?: SpeculateArbiterConfig<THandle, TVerdict>;
  /** Optional post-arbitration winner refinement configuration. */
  readonly refineWinnerWhen?: SpeculateRefineWinnerConfig<
    TParentIn,
    TChildIn,
    TChildOut,
    THandle,
    TVerdict
  >;
}
