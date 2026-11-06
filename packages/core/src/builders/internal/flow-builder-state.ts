import type { z } from 'zod';
import type {
  IsolationScopeASTNode,
  TelemetryCollectorASTNode,
} from '../../ast/domain-ast.types.js';
import type { FlowBranchNode } from '../../ast/flow-branch-node.js';
import type { FlowStepNode } from '../../ast/flow-step-node.js';

/**
 * Immutable copy-on-write state snapshot backing `FlowBuilder`.
 *
 * Holds the flow's input schema, isolation scope, optional telemetry collector,
 * ordered sequence of step and branch nodes, and terminal exit state label.
 *
 * @template TIn      Validated flow input payload type.
 * @template THandle  Runtime handle type of the flow's isolation scope.
 * @template TStepIds Union of literal step and branch identifiers registered in `nodes`.
 */
export interface FlowBuilderState<
  TIn = unknown,
  THandle = unknown,
  TStepIds extends string = never,
> {
  /** Unique flow identifier passed to `H.flow(id)`. */
  readonly id: string;
  /** Zod schema validating work item input payloads entering the flow. */
  readonly inputSchema?: z.ZodType<TIn, z.ZodTypeDef, unknown>;
  /** Capability-tiered isolation scope node governing workspace lifecycle. */
  readonly scope?: IsolationScopeASTNode<THandle>;
  /** Optional telemetry collector folding observed tool effects into custom metrics. */
  readonly telemetry?: TelemetryCollectorASTNode;
  /** Ordered sequence of sequential steps and conditional branches in the flow. */
  readonly nodes: ReadonlyArray<
    | FlowStepNode<unknown, unknown, THandle, TStepIds>
    | FlowBranchNode<TIn, unknown, THandle, TStepIds>
  >;
  /** Terminal exit state label recorded when the flow completes its final node. */
  readonly exitState?: string;
}
