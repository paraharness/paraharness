import type { MaybeBuilder } from '../../ast/ast-foundation.types.js';
import type { StepASTNode } from '../../ast/domain-ast.types.js';
import { extractAST } from '../../ast/extract-ast.js';
import type { FlowBranchNode } from '../../ast/flow-branch-node.js';
import type { FlowStepNode } from '../../ast/flow-step-node.js';
import type { ExtractStepInput, ExtractStepOutput } from '../flow-extraction.types.js';
import type { FlowStepConfigBuilder } from '../flow-step-config-builder.js';
import type { FlowSubBranchBuilder } from '../flow-sub-branch-builder.js';
import { createFlowStepConfigFromState } from './create-flow-step-config-from-state.js';
import { assertNonEmptyIdentifier } from './deep-freeze.js';

/**
 * Creates a copy-on-write immutable `FlowSubBranchBuilder` from an ordered array of sub-branch steps.
 *
 * Appends compiled `FlowStepNode` entries in declaration order and threads accumulated step
 * output types into `TStepOutputs`.
 *
 * @template TFlowIn        Enclosing flow input type.
 * @template TBranchOut     Unified branch output type.
 * @template THandle        Isolation scope handle type.
 * @template TReceipt       Inspected scope receipt type.
 * @template TCustomMetrics Custom step telemetry metrics type.
 * @template TStepOutputs   Accumulated step outputs map type.
 *
 * @param {ReadonlyArray<FlowStepNode<unknown, unknown, THandle> | FlowBranchNode<unknown, unknown, THandle>>} steps - Sub-branch steps.
 *
 * @returns {FlowSubBranchBuilder<TFlowIn, TBranchOut, THandle, TReceipt, TCustomMetrics, TStepOutputs>} Frozen sub-branch builder.
 */
export function createFlowSubBranchFromState<
  TFlowIn = unknown,
  TBranchOut = unknown,
  THandle = unknown,
  TReceipt = unknown,
  TCustomMetrics extends Record<string, unknown> = Record<string, unknown>,
  TStepOutputs extends Record<string, unknown> = Record<string, never>,
>(
  steps: ReadonlyArray<
    FlowStepNode<unknown, unknown, THandle> | FlowBranchNode<unknown, unknown, THandle>
  >,
): FlowSubBranchBuilder<TFlowIn, TBranchOut, THandle, TReceipt, TCustomMetrics, TStepOutputs> {
  return Object.freeze<
    FlowSubBranchBuilder<TFlowIn, TBranchOut, THandle, TReceipt, TCustomMetrics, TStepOutputs>
  >({
    steps,
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
    ) {
      assertNonEmptyIdentifier('M.flow.branch.step', id);
      const baseConfig = createFlowStepConfigFromState<
        TFlowIn,
        ExtractStepInput<TStep>,
        THandle,
        TReceipt,
        TCustomMetrics,
        TStepOutputs,
        TStepId
      >({
        id,
        step: extractAST(step),
        onInterruptHandlers: [],
      });
      const compiledStep = (configure !== undefined ? configure(baseConfig) : baseConfig).toAST();
      return createFlowSubBranchFromState<
        TFlowIn,
        TBranchOut,
        THandle,
        TReceipt,
        TCustomMetrics,
        TStepOutputs & { readonly [K in TStepId]: ExtractStepOutput<TStep> }
      >([...steps, compiledStep]);
    },
  });
}
