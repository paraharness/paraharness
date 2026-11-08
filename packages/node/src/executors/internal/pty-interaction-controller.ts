import type { ToolExecutionResult } from '@paraharness/core';

/**
 * Controller managing lazy PTY interaction sessions and turn dispatch for a running `LocalServiceNode`.
 *
 * Validates tool arguments against the interaction's `inputSchema`, lazily initializes one
 * `PtyFramedInteractiveSession` per tool name, and closes all active PTY sessions on teardown.
 */
export interface PtyInteractionController {
  /**
   * Validates `args` and executes a single framed turn against the named interactive PTY tool.
   *
   * @param {string}      toolName - Name of the `.interact()` tool to invoke.
   * @param {unknown}     args     - Unvalidated tool arguments supplied by the caller.
   * @param {AbortSignal} [signal] - Optional abort signal from the active step execution context.
   *
   * @returns {Promise<ToolExecutionResult>} Framed PTY output wrapped in a `ToolExecutionResult`.
   */
  invokeTool(
    toolName: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult>;

  /**
   * Closes all lazily spawned `PtyFramedInteractiveSession` instances managed by this controller.
   *
   * @returns {Promise<void>} Resolves once all PTY sessions have terminated.
   */
  closeAll(): Promise<void>;
}
