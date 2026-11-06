import type { ToolASTNode } from '../ast/domain-ast.types.js';
import type { StepExecutionContext } from './step-execution-context.js';
import type { ToolExecutionResult } from './tool-execution-result.js';

/**
 * Live background daemon session spawned from a `ServiceASTNode` within an isolation scope.
 *
 * Exposes interaction tools unlocked while the service is mounted and a deterministic `stop()`
 * lifecycle method invoked when the owning skill completes or the step quiesces.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface ServiceSession<THandle = unknown> {
  /** Unique identifier of the service AST node that spawned this session. */
  readonly id: string;
  /** Interaction tool AST nodes exposed to the agent while this service session is active. */
  readonly tools: readonly ToolASTNode<THandle>[];

  /**
   * Invokes one of the service session's exposed interaction tools by name.
   *
   * Executes the interaction request against the running daemon and returns the formatted tool result.
   *
   * @param {string}                        toolName - Name of the service interaction tool to invoke.
   * @param {unknown}                       args     - Tool call arguments supplied by the model.
   * @param {StepExecutionContext<THandle>} ctx      - Active step execution context.
   *
   * @returns {Promise<ToolExecutionResult>} Tool execution result string and error status.
   */
  invokeTool(
    toolName: string,
    args: unknown,
    ctx: StepExecutionContext<THandle>,
  ): Promise<ToolExecutionResult>;

  /**
   * Stops the background daemon process, drains open sockets, and releases its daemon runner slot.
   *
   * Called deterministically when the enclosing skill completes, the step finishes, or the actor suspends.
   *
   * @returns {Promise<void>} Resolves once the daemon session has terminated cleanly.
   */
  stop(): Promise<void>;
}
