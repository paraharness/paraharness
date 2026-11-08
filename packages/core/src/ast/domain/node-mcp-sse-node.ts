import type { BaseControlPlaneASTNode } from '../base/base-control-plane-ast-node.js';

/**
 * Passive AST node exposing a Model Context Protocol (MCP) server over HTTP/SSE (`mcp.server` / `local.mcpSse`).
 *
 * Binds an HTTP/SSE MCP listener on `port` when mounted on `P.harness.exposeControlPlane(...)`.
 */
export interface NodeMcpSseNode extends BaseControlPlaneASTNode<'node:mcp-sse'> {
  /** TCP port on which the MCP HTTP/SSE server listens. */
  readonly port: number;
}
