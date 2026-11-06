import type { AstBuilder } from '../../ast/ast-builder.js';
import type { MaybeBuilder } from '../../ast/ast-foundation.types.js';
import type { StepASTNode } from '../../ast/domain-ast.types.js';
import type { FlowStepInputMapper } from '../../ast/flow-step-input-mapper.types.js';
import type { FlowStepNode } from '../../ast/flow-step-node.js';
import type { InterruptHandlerNode } from '../../ast/interrupt-handler-node.js';
import type { InterruptNode } from '../../ast/interrupt-node.js';
import { createInterruptEdgeBuilder } from '../create-interrupt-edge-builder.js';
import type { FlowStepConfigBuilder } from '../flow-step-config-builder.js';
import type { InterruptEdgeBuilder } from '../interrupt-edge-builder.js';
import { deepFreeze } from './deep-freeze.js';

/**
 * Creates a copy-on-write immutable `FlowStepConfigBuilder` from an internal state snapshot.
 *
 * Binds `.inputFrom(mapper)` and step-level `.onInterrupt(interrupt, $intr => ...)` edges
 * before compiling to a deeply frozen `FlowStepNode`.
 *
 * @template TFlowIn        Enclosing flow input type.
 * @template TStepIn        Target step input type.
 * @template THandle        Isolation scope handle type.
 * @template TReceipt       Inspected scope receipt type.
 * @template TCustomMetrics Custom step telemetry metrics type.
 * @template TStepOutputs   Accumulated step outputs map type.
 * @template TStepId        Literal step identifier string.
 *
 * @param {{ readonly id: TStepId; readonly step: StepASTNode; readonly inputFrom?: FlowStepInputMapper<TStepIn, TFlowIn, TReceipt>; readonly onInterruptHandlers: readonly InterruptHandlerNode<TFlowIn, unknown, THandle>[] }} state - Current step config builder state.
 *
 * @returns {FlowStepConfigBuilder<TFlowIn, TStepIn, THandle, TReceipt, TCustomMetrics, TStepOutputs, TStepId>} Frozen step config builder.
 */
export function createFlowStepConfigFromState<
  TFlowIn = unknown,
  TStepIn = unknown,
  THandle = unknown,
  TReceipt = unknown,
  TCustomMetrics extends Record<string, unknown> = Record<string, unknown>,
  TStepOutputs extends Record<string, unknown> = Record<string, never>,
  TStepId extends string = string,
>(state: {
  readonly id: TStepId;
  readonly step: StepASTNode;
  readonly inputFrom?: FlowStepInputMapper<TStepIn, TFlowIn, TReceipt>;
  readonly onInterruptHandlers: readonly InterruptHandlerNode<TFlowIn, unknown, THandle>[];
}): FlowStepConfigBuilder<
  TFlowIn,
  TStepIn,
  THandle,
  TReceipt,
  TCustomMetrics,
  TStepOutputs,
  TStepId
> {
  return Object.freeze<
    FlowStepConfigBuilder<
      TFlowIn,
      TStepIn,
      THandle,
      TReceipt,
      TCustomMetrics,
      TStepOutputs,
      TStepId
    >
  >({
    inputFrom: (
      mapper: (
        flowInput: TFlowIn,
        priorSteps: Readonly<TStepOutputs>,
        scopeReceipt: TReceipt,
      ) => TStepIn,
    ) =>
      createFlowStepConfigFromState<
        TFlowIn,
        TStepIn,
        THandle,
        TReceipt,
        TCustomMetrics,
        TStepOutputs,
        TStepId
      >({
        ...state,
        inputFrom: mapper,
      }),
    onInterrupt: <TPayload>(
      interrupt: MaybeBuilder<InterruptNode<TPayload>>,
      configure: (
        $intr: InterruptEdgeBuilder<
          TFlowIn,
          TPayload,
          THandle,
          TCustomMetrics,
          Record<string, unknown>
        >,
      ) => AstBuilder<InterruptHandlerNode<TFlowIn, TPayload, THandle>>,
    ) => {
      const handlerNode = configure(
        createInterruptEdgeBuilder<
          TFlowIn,
          TPayload,
          THandle,
          TCustomMetrics,
          Record<string, unknown>
        >(interrupt),
      ).toAST();
      return createFlowStepConfigFromState<
        TFlowIn,
        TStepIn,
        THandle,
        TReceipt,
        TCustomMetrics,
        TStepOutputs,
        TStepId
      >({
        ...state,
        onInterruptHandlers: [...state.onInterruptHandlers, handlerNode],
      });
    },
    toAST: (): FlowStepNode<TStepIn, unknown, THandle, TStepId> =>
      deepFreeze<FlowStepNode<TStepIn, unknown, THandle, TStepId>>({
        type: 'harness:flow-step',
        id: state.id,
        step: state.step,
        inputFrom: state.inputFrom,
        onInterruptHandlers: state.onInterruptHandlers,
      }),
  });
}
