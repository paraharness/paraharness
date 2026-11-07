import type { z } from 'zod';
import type { AstBuilder } from '../ast/ast-builder.js';
import type { FlowBranchNode } from '../ast/flow-branch-node.js';
import type { FlowSubBranchBuilder } from './flow-sub-branch-builder.js';

/**
 * Fluent builder for a conditional multi-way branch inside a `FlowNode` (`.branch(id, $b => ...)`).
 *
 * Configures the unified branch output schema, ordered `when(predicate, ...)` cases,
 * and the required `otherwise(...)` fallback case.
 *
 * @template TFlowIn        Enclosing flow input payload type.
 * @template TBranchOut     Unified output payload type produced by the selected branch.
 * @template THandle        Isolation scope handle type.
 * @template TBranchId      Literal branch step identifier string.
 * @template TReceipt       Inspected scope receipt type.
 * @template TCustomMetrics Custom step telemetry metrics type.
 * @template TStepOutputs   Accumulated step outputs map type.
 */
export interface FlowBranchBuilder<
  TFlowIn = unknown,
  TBranchOut = unknown,
  THandle = unknown,
  TBranchId extends string = string,
  TReceipt = unknown,
  TCustomMetrics extends Record<string, unknown> = Record<string, unknown>,
  TStepOutputs extends Record<string, unknown> = Record<string, never>,
> extends AstBuilder<FlowBranchNode<TFlowIn, TBranchOut, THandle, TBranchId>> {
  /**
   * Binds the unified Zod output validation schema for all cases of this branch.
   *
   * Every branch case (`when` and `otherwise`) must produce an output conforming to `schema`.
   *
   * @template TNewBranchOut Unified branch output payload type.
   *
   * @param {z.ZodType<TNewBranchOut>} schema - Zod schema validating the branch output.
   *
   * @returns {FlowBranchBuilder<TFlowIn, TNewBranchOut, THandle, TBranchId, TReceipt, TCustomMetrics, TStepOutputs>} New immutable branch builder.
   */
  output<TNewBranchOut>(
    schema: z.ZodType<TNewBranchOut>,
  ): FlowBranchBuilder<
    TFlowIn,
    TNewBranchOut,
    THandle,
    TBranchId,
    TReceipt,
    TCustomMetrics,
    TStepOutputs
  >;

  /**
   * Appends a conditional `when(predicate, $sub => ...)` branch case evaluated in declaration order.
   *
   * Throws at builder call time if the sub-branch returned by `configure` contains zero steps.
   *
   * @template TNextOutputs Accumulated step outputs map inside the sub-branch.
   *
   * @param {(input: TFlowIn) => boolean}                                                                                                                                                                      predicate - Synchronous predicate over `flowInput`.
   * @param {($sub: FlowSubBranchBuilder<TFlowIn, TBranchOut, THandle, TReceipt, TCustomMetrics, TStepOutputs>) => FlowSubBranchBuilder<TFlowIn, TBranchOut, THandle, TReceipt, TCustomMetrics, TNextOutputs>} configure - Sub-branch configurator callback.
   *
   * @returns {FlowBranchBuilder<TFlowIn, TBranchOut, THandle, TBranchId, TReceipt, TCustomMetrics, TStepOutputs>} New immutable branch builder.
   */
  when<TNextOutputs extends Record<string, unknown> = TStepOutputs>(
    predicate: (input: TFlowIn) => boolean,
    configure: (
      $sub: FlowSubBranchBuilder<
        TFlowIn,
        TBranchOut,
        THandle,
        TReceipt,
        TCustomMetrics,
        TStepOutputs
      >,
    ) => FlowSubBranchBuilder<TFlowIn, TBranchOut, THandle, TReceipt, TCustomMetrics, TNextOutputs>,
  ): FlowBranchBuilder<
    TFlowIn,
    TBranchOut,
    THandle,
    TBranchId,
    TReceipt,
    TCustomMetrics,
    TStepOutputs
  >;

  /**
   * Configures the fallback `otherwise($sub => ...)` branch executed when no `when` predicate matches.
   *
   * Throws at builder call time if the fallback sub-branch returned by `configure` contains zero steps.
   *
   * @template TNextOutputs Accumulated step outputs map inside the fallback sub-branch.
   *
   * @param {($sub: FlowSubBranchBuilder<TFlowIn, TBranchOut, THandle, TReceipt, TCustomMetrics, TStepOutputs>) => FlowSubBranchBuilder<TFlowIn, TBranchOut, THandle, TReceipt, TCustomMetrics, TNextOutputs>} configure - Fallback sub-branch configurator callback.
   *
   * @returns {FlowBranchBuilder<TFlowIn, TBranchOut, THandle, TBranchId, TReceipt, TCustomMetrics, TStepOutputs>} New immutable branch builder.
   */
  otherwise<TNextOutputs extends Record<string, unknown> = TStepOutputs>(
    configure: (
      $sub: FlowSubBranchBuilder<
        TFlowIn,
        TBranchOut,
        THandle,
        TReceipt,
        TCustomMetrics,
        TStepOutputs
      >,
    ) => FlowSubBranchBuilder<TFlowIn, TBranchOut, THandle, TReceipt, TCustomMetrics, TNextOutputs>,
  ): FlowBranchBuilder<
    TFlowIn,
    TBranchOut,
    THandle,
    TBranchId,
    TReceipt,
    TCustomMetrics,
    TStepOutputs
  >;
}
