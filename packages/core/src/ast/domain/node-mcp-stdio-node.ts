import type { BaseControlPlaneASTNode } from '../base/base-control-plane-ast-node.js';

/**
 * Passive AST node exposing a Model Context Protocol (MCP) server over standard I/O (`local.mcpStdio`).
 *
 * Exposes harness lane enqueueing, signal emission, and run status tools over stdio transport
 * under `serverName`.
 */
export interface NodeMcpStdioNode extends BaseControlPlaneASTNode<'node:mcp-stdio'> {
  /** Logical server name reported during MCP initialization. */
  readonly serverName: string;
}
