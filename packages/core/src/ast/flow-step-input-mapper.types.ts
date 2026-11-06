import type { BivariantCallback } from './ast-foundation.types.js';

/**
 * Synchronous step input projection function mapping `(flowInput, priorSteps, scopeReceipt)` to `TIn`.
 *
 * @template TIn          Target step input payload type.
 * @template TFlowIn      Enclosing flow input payload type.
 * @template TReceipt     Inspected scope receipt type.
 * @template TStepOutputs Prior step outputs map type.
 */
export type FlowStepInputMapper<
  TIn = unknown,
  TFlowIn = unknown,
  TReceipt = unknown,
  TStepOutputs = unknown,
> = BivariantCallback<
  [flowInput: TFlowIn, priorSteps: TStepOutputs, scopeReceipt: TReceipt],
  TIn
>;
