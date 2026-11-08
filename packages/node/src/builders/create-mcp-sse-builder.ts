import type { AstBuilder, NodeMcpSseNode } from '@metaharness/core';
import type { McpServerOptions } from './mcp-namespace-contract.js';

/**
 * Creates an MCP HTTP/SSE control-plane builder and passive AST node (`local.mcpSse({ port })`).
 *
 * Compiles to a frozen `NodeMcpSseNode` (`type: 'node:mcp-sse'`) listening on `options.port`
 * for Server-Sent Events and JSON-RPC control-plane messages.
 *
 * @param {McpServerOptions} options - Control-plane port configuration.
 *
 * @returns {AstBuilder<NodeMcpSseNode> & NodeMcpSseNode} Frozen MCP SSE builder and AST node.
 *
 * @throws {Error} If `options.port` is not a valid TCP port integer (`0..65535`).
 */
export function createMcpSseBuilder(
  options: McpServerOptions,
): AstBuilder<NodeMcpSseNode> & NodeMcpSseNode {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error(
      `local.mcpSse requires an integer TCP port between 0 and 65535, received ${String(options.port)}.`,
    );
  }
  const astNode = Object.freeze<NodeMcpSseNode>({
    type: 'node:mcp-sse',
    port: options.port,
  });
  return Object.freeze<AstBuilder<NodeMcpSseNode> & NodeMcpSseNode>({
    type: 'node:mcp-sse',
    port: options.port,
    toAST(): NodeMcpSseNode {
      return astNode;
    },
  });
}
