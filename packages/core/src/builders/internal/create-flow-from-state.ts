import type { z } from 'zod';
import type { MaybeBuilder } from '../../ast/ast-foundation.types.js';
import type {
  IsolationScopeASTNode,
  StepASTNode,
  TelemetryCollectorASTNode,
} from '../../ast/domain-ast.types.js';
import { extractAST } from '../../ast/extract-ast.js';
import type { FlowNode } from '../../ast/flow-node.js';
import type { FlowBranchBuilder } from '../flow-branch-builder.js';
import type { FlowBuilder } from '../flow-builder.js';
import type {
  ExtractScopeHandle,
  ExtractScopeReceipt,
  ExtractStepInput,
  ExtractStepOutput,
  ExtractTelemetryMetrics,
} from '../flow-extraction.types.js';
import type { FlowStepConfigBuilder } from '../flow-step-config-builder.js';
import { compileFlowStateToNode } from './compile-flow-state-to-node.js';
import { createFlowBranchFromState } from './create-flow-branch-from-state.js';
import { createFlowStepConfigFromState } from './create-flow-step-config-from-state.js';
import { assertNonEmptyIdentifier } from './deep-freeze.js';
import type { FlowBuilderState } from './flow-builder-state.js';

/**
 * Creates a copy-on-write immutable `FlowBuilder` from an internal state snapshot.
 *
 * Threads scope handle (`THandle`), scope receipt (`TReceipt`), custom telemetry metrics
 * (`TCustomMetrics`), and accumulated step outputs (`TStepOutputs`) across fluent calls.
 *
 * @template TIn            Flow input payload type.
 * @template THandle        Isolation scope handle type.
 * @template TStepIds       Union of literal step and branch identifiers.
 * @template TReceipt       Inspected scope receipt type.
 * @template TCustomMetrics Custom step telemetry metrics type.
 * @template TStepOutputs   Accumulated step outputs map type.
 *
 * @param {FlowBuilderState<TIn, THandle, TStepIds>} state - Current flow builder state.
 *
 * @returns {FlowBuilder<TIn, THandle, TStepIds, TReceipt, TCustomMetrics, TStepOutputs>} Frozen flow builder.
 */
export function createFlowFromState<
  TIn = unknown, THandle = unknown, TStepIds extends string = never, TReceipt = unknown,
  TCustomMetrics extends Record<string, unknown> = Record<string, unknown>,
  TStepOutputs extends Record<string, unknown> = Record<string, never>,
>(
  state: FlowBuilderState<TIn, THandle, TStepIds>,
): FlowBuilder<TIn, THandle, TStepIds, TReceipt, TCustomMetrics, TStepOutputs> {
  return Object.freeze<FlowBuilder<TIn, THandle, TStepIds, TReceipt, TCustomMetrics, TStepOutputs>>({
    id: state.id,
    input: <TNewIn>(schema: z.ZodType<TNewIn>) => {
      const wideState: FlowBuilderState<unknown, THandle, TStepIds> = { ...state, inputSchema: undefined };
      return createFlowFromState<TNewIn, THandle, TStepIds, TReceipt, TCustomMetrics, TStepOutputs>({ ...wideState, inputSchema: schema });
    },
    scope: <TScope extends IsolationScopeASTNode>(scope: MaybeBuilder<TScope>) => {
      const wideState: FlowBuilderState<TIn, unknown, TStepIds> = { ...state, scope: undefined };
      return createFlowFromState<TIn, ExtractScopeHandle<TScope>, TStepIds, ExtractScopeReceipt<TScope>, TCustomMetrics, TStepOutputs>({ ...wideState, scope: extractAST(scope) });
    },
    telemetry: <TCollector extends TelemetryCollectorASTNode>(collector: MaybeBuilder<TCollector>) =>
      createFlowFromState<TIn, THandle, TStepIds, TReceipt, ExtractTelemetryMetrics<TCollector>, TStepOutputs>({ ...state, telemetry: extractAST(collector) }),
    step: <TStepId extends string, TStep extends StepASTNode>(
      id: TStepId,
      step: MaybeBuilder<TStep>,
      configure?: (
        $s: FlowStepConfigBuilder<TIn, ExtractStepInput<TStep>, THandle, TReceipt, TCustomMetrics, TStepOutputs, TStepId>,
      ) => FlowStepConfigBuilder<TIn, ExtractStepInput<TStep>, THandle, TReceipt, TCustomMetrics, TStepOutputs, TStepId>,
    ) => {
      assertNonEmptyIdentifier('P.flow.step', id);
      const baseConfig = createFlowStepConfigFromState<TIn, ExtractStepInput<TStep>, THandle, TReceipt, TCustomMetrics, TStepOutputs, TStepId>({ id, step: extractAST(step), onInterruptHandlers: [] });
      const compiledStep = (configure !== undefined ? configure(baseConfig) : baseConfig).toAST();
      const wideState: FlowBuilderState<TIn, THandle, string> = { ...state, __stepIdsBrand: undefined };
      return createFlowFromState<TIn, THandle, TStepIds | TStepId, TReceipt, TCustomMetrics, TStepOutputs & { readonly [K in TStepId]: ExtractStepOutput<TStep> }>({
        ...wideState,
        nodes: [...state.nodes, compiledStep],
      });
    },
    branch: <TBranchId extends string, TBranchOut>(
      id: TBranchId,
      configure: (
        $b: FlowBranchBuilder<TIn, unknown, THandle, TBranchId, TReceipt, TCustomMetrics, TStepOutputs>,
      ) => FlowBranchBuilder<TIn, TBranchOut, THandle, TBranchId, TReceipt, TCustomMetrics, TStepOutputs>,
    ) => {
      assertNonEmptyIdentifier('P.flow.branch', id);
      const branchNode = configure(
        createFlowBranchFromState<TIn, unknown, THandle, TBranchId, TReceipt, TCustomMetrics, TStepOutputs>({ id, outputSchema: undefined, cases: [], otherwiseSteps: [] }),
      ).toAST();
      const wideState: FlowBuilderState<TIn, THandle, string> = { ...state, __stepIdsBrand: undefined };
      return createFlowFromState<TIn, THandle, TStepIds | TBranchId, TReceipt, TCustomMetrics, TStepOutputs & { readonly [K in TBranchId]: TBranchOut }>({
        ...wideState,
        nodes: [...state.nodes, branchNode],
      });
    },
    exit: (exitState: string) => {
      assertNonEmptyIdentifier('P.flow.exit', exitState);
      return createFlowFromState<TIn, THandle, TStepIds, TReceipt, TCustomMetrics, TStepOutputs>({ ...state, exitState });
    },
    toAST: (): FlowNode<TIn, THandle, TStepIds> => compileFlowStateToNode(state),
  });
}
