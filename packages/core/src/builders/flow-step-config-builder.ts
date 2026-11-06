import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type { AstBuilder } from '../ast/ast-builder.js';
import type { FlowStepNode } from '../ast/flow-step-node.js';
import type { InterruptHandlerNode } from '../ast/interrupt-handler-node.types.js';
import type { InterruptNode } from '../ast/interrupt-node.js';
import type { InterruptEdgeBuilder } from './interrupt-edge-builder.js';

/**
 * Fluent step configurator passed to `flow.step(id, step, $s => ...)` and `subBranch.step(id, step, $s => ...)`.
 *
 * Configures step input projection from `(flowInput, priorSteps, scopeReceipt)` and
 * attaches step-level `.onInterrupt()` edge handlers.
 *
 * @template TFlowIn        Enclosing flow input payload type.
 * @template TStepIn        Target step input payload type.
 * @template THandle        Isolation scope handle type.
 * @template TReceipt       Inspected scope receipt type.
 * @template TCustomMetrics Custom step telemetry metrics type.
 * @template TStepOutputs   Accumulated step outputs map type.
 * @template TStepId        Literal step identifier string.
 */
export interface FlowStepConfigBuilder<
  TFlowIn = unknown,
  TStepIn = unknown,
  THandle = unknown,
  TReceipt = unknown,
  TCustomMetrics extends Record<string, unknown> = Record<string, unknown>,
  TStepOutputs extends Record<string, unknown> = Record<string, never>,
  TStepId extends string = string,
> extends AstBuilder<FlowStepNode<TStepIn, unknown, THandle, TStepId>> {
  /**
   * Projects `(flowInput, priorSteps, scopeReceipt)` into the step's input payload `TStepIn`.
   *
   * Invoked immediately before the step executes, after refreshing `scopeReceipt = await scope.inspect(handle)`.
   *
   * @param {(flowInput: TFlowIn, priorSteps: Readonly<TStepOutputs>, scopeReceipt: TReceipt) => TStepIn} mapper - Synchronous step input mapper.
   *
   * @returns {FlowStepConfigBuilder<TFlowIn, TStepIn, THandle, TReceipt, TCustomMetrics, TStepOutputs, TStepId>} New immutable step config builder.
   */
  inputFrom(
    mapper: (flowInput: TFlowIn, priorSteps: Readonly<TStepOutputs>, scopeReceipt: TReceipt) => TStepIn,
  ): FlowStepConfigBuilder<TFlowIn, TStepIn, THandle, TReceipt, TCustomMetrics, TStepOutputs, TStepId>;

  /**
   * Binds a step-level interrupt handler overriding or supplementing actor-level handlers.
   *
   * Step-level handlers take precedence over actor-level `.onInterrupt()` handlers for the same `InterruptNode`.
   *
   * @template TPayload Interrupt payload type.
   *
   * @param {MaybeBuilder<InterruptNode<TPayload>>}                                                                                                                              interrupt - Target interrupt node or builder.
   * @param {($intr: InterruptEdgeBuilder<TFlowIn, TPayload, THandle, TCustomMetrics, Record<string, unknown>>) => AstBuilder<InterruptHandlerNode<TFlowIn, TPayload, THandle>>} configure - Interrupt edge configurator.
   *
   * @returns {FlowStepConfigBuilder<TFlowIn, TStepIn, THandle, TReceipt, TCustomMetrics, TStepOutputs, TStepId>} New immutable step config builder.
   */
  onInterrupt<TPayload>(
    interrupt: MaybeBuilder<InterruptNode<TPayload>>,
    configure: (
      $intr: InterruptEdgeBuilder<TFlowIn, TPayload, THandle, TCustomMetrics, Record<string, unknown>>,
    ) => AstBuilder<InterruptHandlerNode<TFlowIn, TPayload, THandle>>,
  ): FlowStepConfigBuilder<TFlowIn, TStepIn, THandle, TReceipt, TCustomMetrics, TStepOutputs, TStepId>;
}
