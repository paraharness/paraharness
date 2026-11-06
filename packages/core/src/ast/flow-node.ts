import type { z } from 'zod';
import type { IsolationScopeASTNode, TelemetryCollectorASTNode } from './domain-ast.types.js';
import type { FlowBranchNode } from './flow-branch-node.js';
import type { FlowStepNode } from './flow-step-node.js';

/**
 * Passive AST node representing a declarative multi-step workflow (`H.flow(id)`).
 *
 * Binds an input schema, a capability-tiered `IsolationScopeASTNode`, an optional `TelemetryCollectorASTNode`,
 * an ordered sequence of `FlowStepNode` and `FlowBranchNode` items, and a terminal `exitState` label.
 *
 * @template TIn      Validated flow input payload type.
 * @template THandle  Runtime handle type of the flow's isolation scope.
 * @template TStepIds Union of literal step and branch identifiers registered in `nodes`.
 */
export interface FlowNode<
  TIn = unknown,
  THandle = unknown,
  TStepIds extends string = string,
> {
  /** Discriminant identifying a workflow AST node. */
  readonly type: 'harness:flow';
  /** Unique identifier of the flow. */
  readonly id: string;
  /** Zod schema validating the work item input entering the flow. */
  readonly inputSchema: z.ZodType<TIn, z.ZodTypeDef, unknown>;
  /** Passive isolation scope AST node governing workspace lifecycle, checkpoints, and branching. */
  readonly scope: IsolationScopeASTNode<THandle, Record<string, unknown>, Record<string, unknown>>;
  /** Optional passive telemetry collector AST node folding observed `ToolEffect` lists into custom metrics. */
  readonly telemetry?: TelemetryCollectorASTNode<Record<string, unknown>>;
  /** Ordered sequence of step and branch AST nodes executed by the flow. */
  readonly nodes: ReadonlyArray<
    FlowStepNode<unknown, unknown, THandle, TStepIds> | FlowBranchNode<TIn, unknown, THandle, TStepIds>
  >;
  /** Terminal exit state label recorded when the flow completes its final node. */
  readonly exitState: string;
}
