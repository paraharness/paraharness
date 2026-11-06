/**
 * Structured result payload returned by a `ToolDriver.execute` or `ServiceSession.invokeTool` call.
 *
 * Contains the serialized string output presented to the model and an optional error flag.
 */
export interface ToolExecutionResult {
  /** Serialized text or JSON string output returned to the model as a `tool_result`. */
  readonly content: string;
  /** Optional flag indicating that the tool invocation failed or was denied. */
  readonly isError?: boolean;
}
