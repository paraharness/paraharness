import type { AstBuilder, NodeHttpControlPlaneNode } from '@metaharness/core';
import type { McpServerOptions } from './mcp-namespace-contract.js';

/**
 * Creates an HTTP / MCP control-plane builder and passive AST node (`mcp.server({ port })`).
 *
 * Compiles to a frozen `NodeHttpControlPlaneNode` (`type: 'node:http-control-plane'`) bound
 * to `options.port` when exposed on `M.harness().expose(...)`.
 *
 * @param {McpServerOptions} options - Control-plane port configuration.
 *
 * @returns {AstBuilder<NodeHttpControlPlaneNode> & NodeHttpControlPlaneNode} Frozen control-plane builder and AST node.
 *
 * @throws {Error} If `options.port` is not a valid TCP port integer (`0..65535`).
 */
export function createMcpServerBuilder(
  options: McpServerOptions,
): AstBuilder<NodeHttpControlPlaneNode> & NodeHttpControlPlaneNode {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error(
      `mcp.server requires an integer TCP port between 0 and 65535, received ${String(options.port)}.`,
    );
  }
  const astNode = Object.freeze<NodeHttpControlPlaneNode>({
    type: 'node:http-control-plane',
    port: options.port,
  });
  return Object.freeze<AstBuilder<NodeHttpControlPlaneNode> & NodeHttpControlPlaneNode>({
    type: 'node:http-control-plane',
    port: options.port,
    toAST(): NodeHttpControlPlaneNode {
      return astNode;
    },
  });
}
