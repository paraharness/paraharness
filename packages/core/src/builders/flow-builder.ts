import type { z } from 'zod';
import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type { AstBuilder } from '../ast/ast-builder.js';
import type {
  IsolationScopeASTNode,
  StepASTNode,
  TelemetryCollectorASTNode,
} from '../ast/domain-ast.types.js';
import type { FlowNode } from '../ast/flow-node.js';
import type { FlowBranchBuilder } from './flow-branch-builder.js';
import type {
  ExtractScopeHandle,
  ExtractScopeReceipt,
  ExtractStepInput,
  ExtractStepOutput,
  ExtractTelemetryMetrics,
} from './flow-extraction.types.js';
import type { FlowStepConfigBuilder } from './flow-step-config-builder.js';

/**
 * Fluent builder for a declarative multi-step workflow (`H.flow(id)`).
 *
 * Threads `THandle`, `TReceipt`, `TCustomMetrics`, `TStepIds`, and `TStepOutputs`
 * across sequential `.step()` and conditional `.branch()` declarations while enforcing
 * scope capability tiers at `.toAST()` compilation time.
 *
 * @template TIn            Validated flow input payload type.
 * @template THandle        Runtime handle type of the flow's isolation scope.
 * @template TStepIds       Union of literal step and branch identifiers registered in `nodes`.
 * @template TReceipt       Inspected scope receipt type inferred from `.scope(scope)`.
 * @template TCustomMetrics Custom step telemetry metrics type inferred from `.telemetry(collector)`.
 * @template TStepOutputs   Typed map of completed step and branch outputs indexed by literal step ID.
 */
export interface FlowBuilder<
  TIn = unknown,
  THandle = unknown,
  TStepIds extends string = never,
  TReceipt = unknown,
  TCustomMetrics extends Record<string, unknown> = Record<string, unknown>,
  TStepOutputs extends Record<string, unknown> = Record<string, never>,
> extends AstBuilder<FlowNode<TIn, THandle, TStepIds>> {
  /** Unique identifier of the flow. */
  readonly id: string;

  /**
   * Binds the Zod validation schema for the work item input entering the flow.
   *
   * Narrows `TIn` to `TNewIn` for all subsequent step input mappers and branch predicates.
   *
   * @template TNewIn Validated flow input payload type.
   *
   * @param {z.ZodType<TNewIn>} schema - Zod schema validating flow input.
   *
   * @returns {FlowBuilder<TNewIn, THandle, TStepIds, TReceipt, TCustomMetrics, TStepOutputs>} New immutable flow builder.
   */
  input<TNewIn>(
    schema: z.ZodType<TNewIn>,
  ): FlowBuilder<TNewIn, THandle, TStepIds, TReceipt, TCustomMetrics, TStepOutputs>;

  /**
   * Binds the capability-tiered `IsolationScopeASTNode` governing workspace lifecycle, checkpoints, and branching.
   *
   * Infers both `ExtractScopeHandle<TScope>` and `ExtractScopeReceipt<TScope>` from `scope`.
   *
   * @template TScope Isolation scope AST node type.
   *
   * @param {MaybeBuilder<TScope>} scope - Isolation scope AST node or builder.
   *
   * @returns {FlowBuilder<TIn, ExtractScopeHandle<TScope>, TStepIds, ExtractScopeReceipt<TScope>, TCustomMetrics, TStepOutputs>} New immutable flow builder.
   */
  scope<TScope extends IsolationScopeASTNode>(
    scope: MaybeBuilder<TScope>,
  ): FlowBuilder<TIn, ExtractScopeHandle<TScope>, TStepIds, ExtractScopeReceipt<TScope>, TCustomMetrics, TStepOutputs>;

  /**
   * Binds an optional `TelemetryCollectorASTNode` folding observed `ToolEffect` lists into custom metrics.
   *
   * Infers `ExtractTelemetryMetrics<TCollector>` for downstream `.replaceWith(...)` telemetry callbacks.
   *
   * @template TCollector Telemetry collector AST node type.
   *
   * @param {MaybeBuilder<TCollector>} collector - Telemetry collector AST node or builder.
   *
   * @returns {FlowBuilder<TIn, THandle, TStepIds, TReceipt, ExtractTelemetryMetrics<TCollector>, TStepOutputs>} New immutable flow builder.
   */
  telemetry<TCollector extends TelemetryCollectorASTNode>(
    collector: MaybeBuilder<TCollector>,
  ): FlowBuilder<TIn, THandle, TStepIds, TReceipt, ExtractTelemetryMetrics<TCollector>, TStepOutputs>;

  /**
   * Appends a sequential step to the flow and records its output type under `TStepOutputs[TStepId]`.
   *
   * Adds `TStepId` to `TStepIds` so `lane.onSignal(...).rewindTo(stepId)` is type-checked against known step IDs.
   *
   * @template TStepId Literal step identifier string.
   * @template TStep   Step AST node type.
   *
   * @param {TStepId}                                                                                                                                                                                                                              id          - Unique step identifier.
   * @param {MaybeBuilder<TStep>}                                                                                                                                                                                                                  step        - Step AST node or builder.
   * @param {($s: FlowStepConfigBuilder<TIn, ExtractStepInput<TStep>, THandle, TReceipt, TCustomMetrics, TStepOutputs, TStepId>) => FlowStepConfigBuilder<TIn, ExtractStepInput<TStep>, THandle, TReceipt, TCustomMetrics, TStepOutputs, TStepId>} [configure] - Optional step input and interrupt configurator.
   *
   * @returns {FlowBuilder<TIn, THandle, TStepIds | TStepId, TReceipt, TCustomMetrics, TStepOutputs & { readonly [K in TStepId]: ExtractStepOutput<TStep> }>} New immutable flow builder.
   */
  step<TStepId extends string, TStep extends StepASTNode>(
    id: TStepId,
    step: MaybeBuilder<TStep>,
    configure?: (
      $s: FlowStepConfigBuilder<TIn, ExtractStepInput<TStep>, THandle, TReceipt, TCustomMetrics, TStepOutputs, TStepId>,
    ) => FlowStepConfigBuilder<TIn, ExtractStepInput<TStep>, THandle, TReceipt, TCustomMetrics, TStepOutputs, TStepId>,
  ): FlowBuilder<
    TIn,
    THandle,
    TStepIds | TStepId,
    TReceipt,
    TCustomMetrics,
    TStepOutputs & { readonly [K in TStepId]: ExtractStepOutput<TStep> }
  >;

  /**
   * Appends a conditional multi-way branch to the flow and records its unified output type under `TStepOutputs[TBranchId]`.
   *
   * Adds `TBranchId` to `TStepIds` and validates that the branch has an output schema, at least one `when`, and an `otherwise`.
   *
   * @template TBranchId  Literal branch identifier string.
   * @template TBranchOut Unified branch output payload type.
   *
   * @param {TBranchId}                                                                                                                                                                                           id        - Unique branch identifier.
   * @param {($b: FlowBranchBuilder<TIn, unknown, THandle, TBranchId, TReceipt, TCustomMetrics, TStepOutputs>) => FlowBranchBuilder<TIn, TBranchOut, THandle, TBranchId, TReceipt, TCustomMetrics, TStepOutputs>} configure - Branch configurator callback.
   *
   * @returns {FlowBuilder<TIn, THandle, TStepIds | TBranchId, TReceipt, TCustomMetrics, TStepOutputs & { readonly [K in TBranchId]: TBranchOut }>} New immutable flow builder.
   */
  branch<TBranchId extends string, TBranchOut>(
    id: TBranchId,
    configure: (
      $b: FlowBranchBuilder<TIn, unknown, THandle, TBranchId, TReceipt, TCustomMetrics, TStepOutputs>,
    ) => FlowBranchBuilder<TIn, TBranchOut, THandle, TBranchId, TReceipt, TCustomMetrics, TStepOutputs>,
  ): FlowBuilder<
    TIn,
    THandle,
    TStepIds | TBranchId,
    TReceipt,
    TCustomMetrics,
    TStepOutputs & { readonly [K in TBranchId]: TBranchOut }
  >;

  /**
   * Sets the terminal exit state label recorded when the flow completes its final node.
   *
   * Required before `.toAST()` can compile a valid `FlowNode`.
   *
   * @param {string} exitState - Terminal exit state label (e.g. `'done'`).
   *
   * @returns {FlowBuilder<TIn, THandle, TStepIds, TReceipt, TCustomMetrics, TStepOutputs>} New immutable flow builder.
   */
  exit(
    exitState: string,
  ): FlowBuilder<TIn, THandle, TStepIds, TReceipt, TCustomMetrics, TStepOutputs>;
}
