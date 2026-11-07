import type { z } from 'zod';
import type { BivariantCallback } from './ast-foundation.types.js';
import type { FlowStepNode } from './flow-step-node.js';

/**
 * Conditional branch case entry (`when(predicate, $sub => ...)`) inside a `FlowBranchNode`.
 *
 * Pairs a synchronous `predicate` over `flowInput` with the ordered sequence of steps or
 * nested branches executed when `predicate` evaluates to `true`.
 *
 * @template TFlowIn Enclosing flow input payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface FlowBranchCase<TFlowIn = unknown, THandle = unknown> {
  /** Synchronous predicate evaluated against `flowInput` to select this branch case. */
  readonly predicate: BivariantCallback<[input: TFlowIn], boolean>;
  /** Ordered sequence of steps or nested branches executed when `predicate(flowInput)` returns `true`. */
  readonly steps: ReadonlyArray<
    FlowStepNode<unknown, unknown, THandle> | FlowBranchNode<unknown, unknown, THandle>
  >;
}

/**
 * Passive AST node representing a conditional multi-way branch inside a `FlowNode` (`.branch(id, $b => ...)`).
 *
 * All branch cases and the fallback `otherwiseSteps` produce outputs validated against `outputSchema`
 * and recorded in `completedStepOutputsJson` under the outer `id: TBranchId`.
 *
 * @template TFlowIn    Enclosing flow input payload type.
 * @template TBranchOut Unified output payload type produced by the selected branch.
 * @template THandle    Runtime handle type of the active isolation scope.
 * @template TBranchId  Literal branch step identifier string.
 */
export interface FlowBranchNode<
  TFlowIn = unknown,
  TBranchOut = unknown,
  THandle = unknown,
  TBranchId extends string = string,
> {
  /** Discriminant identifying a flow branch AST node. */
  readonly type: 'harness:flow-branch';
  /** Unique literal identifier of the branch node within the enclosing flow. */
  readonly id: TBranchId;
  /** Zod schema validating the output of whichever branch case executes. */
  readonly outputSchema: z.ZodType<TBranchOut>;
  /** Ordered list of conditional `when` branch cases evaluated in declaration order. */
  readonly cases: readonly FlowBranchCase<TFlowIn, THandle>[];
  /** Fallback steps executed when no `cases` predicate matches. */
  readonly otherwiseSteps: ReadonlyArray<
    FlowStepNode<unknown, unknown, THandle> | FlowBranchNode<unknown, unknown, THandle>
  >;
}
