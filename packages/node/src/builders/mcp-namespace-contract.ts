import type {
  AstBuilder,
  NodeHttpControlPlaneNode,
  NodeMcpSseNode,
  NodeMcpStdioNode,
} from '@metaharness/core';

/**
 * Configuration options for exposing a local HTTP or MCP SSE control-plane server (`mcp.server` / `local.mcpSse`).
 *
 * Specifies the TCP port on which the control-plane server binds when the harness runtime starts.
 */
export interface McpServerOptions {
  /** TCP port on which the HTTP or MCP SSE server listens. */
  readonly port: number;
}

/**
 * Public `mcp.*` DSL builder namespace exported by `@metaharness/node`.
 *
 * Exposes Model Context Protocol (MCP) and HTTP control-plane builders (`mcp.server`,
 * `mcp.stdio`, `mcp.sse`) for mounting on `M.harness().expose(...)`.
 */
export interface McpNamespace {
  /**
   * Creates an HTTP / MCP control-plane server descriptor listening on `options.port` (`mcp.server`).
   *
   * Compiles to `NodeHttpControlPlaneNode` (`type: 'node:http-control-plane'`).
   *
   * @param {McpServerOptions} options - TCP port configuration.
   *
   * @returns {AstBuilder<NodeHttpControlPlaneNode> & NodeHttpControlPlaneNode} Frozen control-plane node.
   */
  server(
    options: McpServerOptions,
  ): AstBuilder<NodeHttpControlPlaneNode> & NodeHttpControlPlaneNode;

  /**
   * Creates an MCP stdio control-plane server descriptor (`mcp.stdio`).
   *
   * Compiles to `NodeMcpStdioNode` (`type: 'node:mcp-stdio'`).
   *
   * @param {string} [serverName='metaharness-mcp'] - Logical MCP server name.
   *
   * @returns {AstBuilder<NodeMcpStdioNode> & NodeMcpStdioNode} Frozen MCP stdio control-plane node.
   */
  stdio(serverName?: string): AstBuilder<NodeMcpStdioNode> & NodeMcpStdioNode;

  /**
   * Creates an MCP HTTP/SSE control-plane server descriptor (`mcp.sse`).
   *
   * Compiles to `NodeMcpSseNode` (`type: 'node:mcp-sse'`).
   *
   * @param {McpServerOptions} options - TCP port configuration.
   *
   * @returns {AstBuilder<NodeMcpSseNode> & NodeMcpSseNode} Frozen MCP SSE control-plane node.
   */
  sse(options: McpServerOptions): AstBuilder<NodeMcpSseNode> & NodeMcpSseNode;
}
