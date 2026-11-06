import type { z } from 'zod';
import type { FlowBranchCase, FlowBranchNode } from '../../ast/flow-branch-node.js';
import type { FlowStepNode } from '../../ast/flow-step-node.js';
import type { FlowBranchBuilder } from '../flow-branch-builder.js';
import type { FlowSubBranchBuilder } from '../flow-sub-branch-builder.js';
import { createFlowStepConfigFromState } from './create-flow-step-config-from-state.js';
import { createFlowSubBranchFromState } from './create-flow-sub-branch-from-state.js';
import { deepFreeze } from './deep-freeze.js';

export { createFlowStepConfigFromState, createFlowSubBranchFromState };

/**
 * Creates a copy-on-write immutable `FlowBranchBuilder` from an internal state snapshot.
 *
 * Accumulates ordered `.when(predicate, $sub => ...)` cases and the fallback `.otherwise($sub => ...)`
 * sub-branch before validating `.output(schema)` at `.toAST()` compilation time.
 *
 * @template TFlowIn        Enclosing flow input type.
 * @template TBranchOut     Unified branch output type.
 * @template THandle        Isolation scope handle type.
 * @template TBranchId      Literal branch identifier string.
 * @template TReceipt       Inspected scope receipt type.
 * @template TCustomMetrics Custom step telemetry metrics type.
 * @template TStepOutputs   Accumulated step outputs map type.
 *
 * @param {{ readonly id: TBranchId; readonly outputSchema?: z.ZodType<TBranchOut, z.ZodTypeDef, unknown>; readonly cases: readonly FlowBranchCase<TFlowIn, THandle>[]; readonly otherwiseSteps: ReadonlyArray<FlowStepNode<unknown, unknown, THandle> | FlowBranchNode<unknown, unknown, THandle>> }} state - Current branch builder state.
 *
 * @returns {FlowBranchBuilder<TFlowIn, TBranchOut, THandle, TBranchId, TReceipt, TCustomMetrics, TStepOutputs>} Frozen branch builder.
 */
export function createFlowBranchFromState<
  TFlowIn = unknown,
  TBranchOut = unknown,
  THandle = unknown,
  TBranchId extends string = string,
  TReceipt = unknown,
  TCustomMetrics extends Record<string, unknown> = Record<string, unknown>,
  TStepOutputs extends Record<string, unknown> = Record<string, never>,
>(state: {
  readonly id: TBranchId;
  readonly outputSchema?: z.ZodType<TBranchOut, z.ZodTypeDef, unknown>;
  readonly cases: readonly FlowBranchCase<TFlowIn, THandle>[];
  readonly otherwiseSteps: ReadonlyArray<
    FlowStepNode<unknown, unknown, THandle> | FlowBranchNode<unknown, unknown, THandle>
  >;
}): FlowBranchBuilder<
  TFlowIn,
  TBranchOut,
  THandle,
  TBranchId,
  TReceipt,
  TCustomMetrics,
  TStepOutputs
> {
  return Object.freeze<
    FlowBranchBuilder<
      TFlowIn,
      TBranchOut,
      THandle,
      TBranchId,
      TReceipt,
      TCustomMetrics,
      TStepOutputs
    >
  >({
    output: <TNewBranchOut>(schema: z.ZodType<TNewBranchOut, z.ZodTypeDef, unknown>) =>
      createFlowBranchFromState<
        TFlowIn,
        TNewBranchOut,
        THandle,
        TBranchId,
        TReceipt,
        TCustomMetrics,
        TStepOutputs
      >({
        id: state.id,
        outputSchema: schema,
        cases: state.cases,
        otherwiseSteps: state.otherwiseSteps,
      }),
    when: <TNextOutputs extends Record<string, unknown> = TStepOutputs>(
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
    ) => {
      const subBranch = configure(
        createFlowSubBranchFromState<
          TFlowIn,
          TBranchOut,
          THandle,
          TReceipt,
          TCustomMetrics,
          TStepOutputs
        >([]),
      );
      return createFlowBranchFromState<
        TFlowIn,
        TBranchOut,
        THandle,
        TBranchId,
        TReceipt,
        TCustomMetrics,
        TStepOutputs
      >({
        ...state,
        cases: [...state.cases, { predicate, steps: subBranch.steps }],
      });
    },
    otherwise: <TNextOutputs extends Record<string, unknown> = TStepOutputs>(
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
    ) => {
      const subBranch = configure(
        createFlowSubBranchFromState<
          TFlowIn,
          TBranchOut,
          THandle,
          TReceipt,
          TCustomMetrics,
          TStepOutputs
        >([]),
      );
      return createFlowBranchFromState<
        TFlowIn,
        TBranchOut,
        THandle,
        TBranchId,
        TReceipt,
        TCustomMetrics,
        TStepOutputs
      >({
        ...state,
        otherwiseSteps: subBranch.steps,
      });
    },
    toAST: (): FlowBranchNode<TFlowIn, TBranchOut, THandle, TBranchId> => {
      if (state.outputSchema === undefined) {
        throw new Error(`Flow branch '${state.id}' requires .output(schema).`);
      }
      return deepFreeze<FlowBranchNode<TFlowIn, TBranchOut, THandle, TBranchId>>({
        type: 'harness:flow-branch',
        id: state.id,
        outputSchema: state.outputSchema,
        cases: state.cases,
        otherwiseSteps: state.otherwiseSteps,
      });
    },
  });
}
