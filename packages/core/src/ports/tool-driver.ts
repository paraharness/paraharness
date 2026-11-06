import type { ToolASTNode } from '../ast/domain-ast.types.js';
import type { NodeExecutor } from './node-executor.types.js';
import type { StepExecutionContext } from './step-execution-context.js';
import type { ToolEffect } from './tool-effect.js';
import type { ToolExecutionResult } from './tool-execution-result.js';

/**
 * Runtime port for executing a `ToolASTNode` and optionally predicting its pre-flight `ToolEffect` list.
 *
 * Tools with `effectTracking === 'declared'` implement `describeEffects` for pre-flight policy guard evaluation,
 * whereas tools with `effectTracking === 'subprocess-post-flight'` omit `describeEffects` so the runtime enforces
 * `CheckpointableScope.diffEffects()` post-flight verification.
 *
 * @template TNode   Concrete `ToolASTNode` subtype handled by this driver.
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface ToolDriver<
  TNode extends ToolASTNode<THandle> = ToolASTNode<unknown>,
  THandle = unknown,
> {
  /**
   * Predicts the domain-agnostic `ToolEffect` descriptors that executing `node` with `args` will produce.
   *
   * Invoked prior to tool execution so policy guards and scope lock managers can evaluate proposed effects pre-flight.
   *
   * @param {TNode}   node        - Passive tool AST node being invoked.
   * @param {unknown} args        - Validated tool call arguments from the model.
   * @param {THandle} scopeHandle - Active isolation scope handle.
   *
   * @returns {readonly ToolEffect[] | Promise<readonly ToolEffect[]>} Predicted pre-flight tool effects.
   */
  describeEffects?(
    node: TNode,
    args: unknown,
    scopeHandle: THandle,
  ): readonly ToolEffect[] | Promise<readonly ToolEffect[]>;

  /** Stateless executor that runs the tool against the active `StepExecutionContext`. */
  readonly execute: NodeExecutor<
    TNode,
    unknown,
    ToolExecutionResult,
    StepExecutionContext<THandle>
  >;
}
