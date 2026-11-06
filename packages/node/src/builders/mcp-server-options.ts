/**
 * Configuration options for exposing a local HTTP or MCP SSE control-plane server (`mcp.server` / `local.mcpSse`).
 *
 * Specifies the TCP port on which the control-plane server binds when the harness runtime starts.
 */
export interface McpServerOptions {
  /** TCP port on which the HTTP or MCP SSE server listens. */
  readonly port: number;
}
