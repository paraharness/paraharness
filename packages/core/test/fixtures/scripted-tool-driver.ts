import type { ToolASTNode } from '../../src/ast/domain-ast.types.js';
import type { StepExecutionContext } from '../../src/ports/step-execution-context.js';
import type { ToolDriver } from '../../src/ports/tool-driver.js';
import type { ToolEffect } from '../../src/ports/tool-effect.js';
import type { ToolExecutionResult } from '../../src/ports/tool-execution-result.js';

/**
 * Deterministic `ToolDriver` test fixture supporting configurable `describeEffects` and scripted execution handlers (`SPEC.md` §3.5).
 *
 * Tracks invocation count and recorded arguments for verifying pre-flight batching and post-flight rollback guarantees.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export class ScriptedToolDriver<THandle = unknown> implements ToolDriver<ToolASTNode<unknown>, unknown> {
  /** Recorded tool invocations `(toolName, args, scopeHandle)`. */
  readonly invocations: Array<{ readonly toolName: string; readonly args: unknown; readonly scopeHandle: THandle }> = [];
  /** Optional pre-flight effect predictor callback. */
  private readonly effectPredictor?: (node: ToolASTNode<THandle>, args: unknown, scopeHandle: THandle) => readonly ToolEffect[];
  /** Custom tool execution callback. */
  private readonly handler: (node: ToolASTNode<THandle>, args: unknown, ctx: StepExecutionContext<THandle>) => ToolExecutionResult | Promise<ToolExecutionResult>;
  /** Bound `execute` function satisfying `ToolDriver.execute`. */
  readonly execute: (node: ToolASTNode<unknown>, args: unknown, ctx: StepExecutionContext<unknown>) => Promise<ToolExecutionResult>;

  /**
   * Creates a `ScriptedToolDriver` with optional `describeEffects` and `handler` callbacks.
   *
   * Binds `execute` to record each invocation in `invocations`.
   *
   * @param {{ readonly describeEffects?: (node: ToolASTNode<THandle>, args: unknown, scopeHandle: THandle) => readonly ToolEffect[]; readonly handler?: (node: ToolASTNode<THandle>, args: unknown, ctx: StepExecutionContext<THandle>) => ToolExecutionResult | Promise<ToolExecutionResult> }} [options] - Driver configuration callbacks.
   */
  constructor(options?: {
    readonly describeEffects?: (node: ToolASTNode<THandle>, args: unknown, scopeHandle: THandle) => readonly ToolEffect[];
    readonly handler?: (node: ToolASTNode<THandle>, args: unknown, ctx: StepExecutionContext<THandle>) => ToolExecutionResult | Promise<ToolExecutionResult>;
  }) {
    this.effectPredictor = options?.describeEffects;
    this.handler = options?.handler ?? ((node, args) => Object.freeze({ content: `executed:${node.name}:${JSON.stringify(args)}`, isError: false }));
    this.execute = async (node: ToolASTNode<unknown>, args: unknown, ctx: StepExecutionContext<unknown>): Promise<ToolExecutionResult> => {
      const typedNode = node as ToolASTNode<THandle>;
      const typedCtx = ctx as StepExecutionContext<THandle>;
      this.invocations.push(Object.freeze({ toolName: typedNode.name, args, scopeHandle: typedCtx.scopeHandle }));
      return await this.handler(typedNode, args, typedCtx);
    };
  }

  /**
   * Predicts pre-flight `ToolEffect` descriptors using `effectPredictor` when configured.
   *
   * Returns an empty list if no `effectPredictor` was provided.
   *
   * @param {ToolASTNode<unknown>} node        - Passive tool AST node.
   * @param {unknown}              args        - Validated tool arguments.
   * @param {unknown}              scopeHandle - Active scope handle.
   *
   * @returns {readonly ToolEffect[]} Predicted tool effects.
   */
  describeEffects(node: ToolASTNode<unknown>, args: unknown, scopeHandle: unknown): readonly ToolEffect[] {
    return this.effectPredictor !== undefined
      ? this.effectPredictor(node as ToolASTNode<THandle>, args, scopeHandle as THandle)
      : Object.freeze([]);
  }
}
