import type { FlowBranchBuilder } from './flow-branch-builder.js';
import { createFlowBranchFromState } from './internal/create-flow-branch-from-state.js';
import { assertNonEmptyIdentifier } from './internal/deep-freeze.js';

/**
 * Creates a fluent `FlowBranchBuilder` for `flow.branch(id, $b => ...)`.
 *
 * Validates that `id` is a non-empty branch identifier and initializes an immutable
 * `FlowBranchBuilder` with empty `.when()` cases and `.otherwise()` fallback steps.
 *
 * @template TFlowIn        Enclosing flow input payload type.
 * @template TBranchOut     Unified branch output payload type.
 * @template THandle        Isolation scope handle type.
 * @template TBranchId      Literal branch step identifier string.
 * @template TReceipt       Inspected scope receipt type.
 * @template TCustomMetrics Custom step telemetry metrics type.
 * @template TStepOutputs   Accumulated step outputs map type.
 *
 * @param {TBranchId} id - Unique identifier of the branch node.
 *
 * @returns {FlowBranchBuilder<TFlowIn, TBranchOut, THandle, TBranchId, TReceipt, TCustomMetrics, TStepOutputs>} Frozen branch builder.
 */
export function createFlowBranchBuilder<
  TFlowIn = unknown,
  TBranchOut = unknown,
  THandle = unknown,
  TBranchId extends string = string,
  TReceipt = unknown,
  TCustomMetrics extends Record<string, unknown> = Record<string, unknown>,
  TStepOutputs extends Record<string, unknown> = Record<string, never>,
>(
  id: TBranchId,
): FlowBranchBuilder<
  TFlowIn,
  TBranchOut,
  THandle,
  TBranchId,
  TReceipt,
  TCustomMetrics,
  TStepOutputs
> {
  assertNonEmptyIdentifier('P.flow.branch', id);
  return createFlowBranchFromState({
    id,
    outputSchema: undefined,
    cases: [],
    otherwiseSteps: [],
  });
}
