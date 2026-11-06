import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type { StepASTNode } from '../ast/domain-ast.types.js';
import type { FlowBranchNode } from '../ast/flow-branch-node.js';
import type { FlowStepNode } from '../ast/flow-step-node.js';
import type {
  ExtractStepInput,
  ExtractStepOutput,
} from './flow-extraction.types.js';
import type { FlowStepConfigBuilder } from './flow-step-config-builder.js';

/**
 * Fluent sub-builder passed to `FlowBranchBuilder.when(...)` and `FlowBranchBuilder.otherwise(...)`.
 *
 * Appends sequential steps inside a conditional branch case and threads accumulated
 * step output types across `.step(...)` calls.
 *
 * @template TFlowIn        Enclosing flow input payload type.
 * @template TBranchOut     Unified branch output payload type.
 * @template THandle        Isolation scope handle type.
 * @template TReceipt       Inspected scope receipt type.
 * @template TCustomMetrics Custom step telemetry metrics type.
 * @template TStepOutputs   Accumulated step outputs map type.
 */
export interface FlowSubBranchBuilder<
  TFlowIn = unknown,
  TBranchOut = unknown,
  THandle = unknown,
  TReceipt = unknown,
  TCustomMetrics extends Record<string, unknown> = Record<string, unknown>,
  TStepOutputs extends Record<string, unknown> = Record<string, never>,
> {
  /** Ordered sequence of steps or nested branches inside this sub-branch. */
  readonly steps: ReadonlyArray<
    FlowStepNode<unknown, unknown, THandle> | FlowBranchNode<unknown, unknown, THandle>
  >;

  /**
   * Appends a sequential step inside this branch case.
   *
   * Records the step's output type under `TStepOutputs[TStepId]` for subsequent steps in the same sub-branch.
   *
   * @template TStepId Literal step identifier string.
   * @template TStep   Step AST node type.
   *
   * @param {TStepId}                                                                                                                                                                                                                                      id          - Unique step identifier.
   * @param {MaybeBuilder<TStep>}                                                                                                                                                                                                                          step        - Step AST node or builder.
   * @param {($s: FlowStepConfigBuilder<TFlowIn, ExtractStepInput<TStep>, THandle, TReceipt, TCustomMetrics, TStepOutputs, TStepId>) => FlowStepConfigBuilder<TFlowIn, ExtractStepInput<TStep>, THandle, TReceipt, TCustomMetrics, TStepOutputs, TStepId>} [configure] - Optional step input and interrupt configurator.
   *
   * @returns {FlowSubBranchBuilder<TFlowIn, TBranchOut, THandle, TReceipt, TCustomMetrics, TStepOutputs & { readonly [K in TStepId]: ExtractStepOutput<TStep> }>} New immutable sub-branch builder.
   */
  step<TStepId extends string, TStep extends StepASTNode>(
    id: TStepId,
    step: MaybeBuilder<TStep>,
    configure?: (
      $s: FlowStepConfigBuilder<
        TFlowIn,
        ExtractStepInput<TStep>,
        THandle,
        TReceipt,
        TCustomMetrics,
        TStepOutputs,
        TStepId
      >,
    ) => FlowStepConfigBuilder<
      TFlowIn,
      ExtractStepInput<TStep>,
      THandle,
      TReceipt,
      TCustomMetrics,
      TStepOutputs,
      TStepId
    >,
  ): FlowSubBranchBuilder<
    TFlowIn,
    TBranchOut,
    THandle,
    TReceipt,
    TCustomMetrics,
    TStepOutputs & { readonly [K in TStepId]: ExtractStepOutput<TStep> }
  >;
}
