import type { AstBuilder, NodeMcpStdioNode } from '@metaharness/core';

/**
 * Creates an MCP stdio control-plane builder and passive AST node (`local.mcpStdio(serverName)`).
 *
 * Compiles to a frozen `NodeMcpStdioNode` (`type: 'node:mcp-stdio'`) exposing runtime status
 * and signal triggers over standard I/O transport.
 *
 * @param {string} [serverName='metaharness-mcp'] - Logical MCP server name reported on initialization.
 *
 * @returns {AstBuilder<NodeMcpStdioNode> & NodeMcpStdioNode} Frozen MCP stdio builder and AST node.
 *
 * @throws {Error} If `serverName` is empty or whitespace-only.
 */
export function createMcpStdioBuilder(
  serverName = 'metaharness-mcp',
): AstBuilder<NodeMcpStdioNode> & NodeMcpStdioNode {
  if (serverName.trim().length === 0) {
    throw new Error('local.mcpStdio requires a non-empty serverName.');
  }
  const astNode = Object.freeze<NodeMcpStdioNode>({
    type: 'node:mcp-stdio',
    serverName,
  });
  return Object.freeze<AstBuilder<NodeMcpStdioNode> & NodeMcpStdioNode>({
    type: 'node:mcp-stdio',
    serverName,
    toAST(): NodeMcpStdioNode {
      return astNode;
    },
  });
}
