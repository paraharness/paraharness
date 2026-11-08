import type {
  ControlPlaneAdapter,
  ControlPlaneHandle,
  HarnessRuntimeController,
  NodeHttpControlPlaneNode,
  NodeMcpSseNode,
  NodeMcpStdioNode,
  RuntimeDriverContext,
} from '@paraharness/core';
import { buildControlPlaneMcpServer } from './internal/build-control-plane-mcp-server.js';
import { connectStdioControlPlaneTransport } from './internal/connect-stdio-control-plane-transport.js';
import { startHttpControlPlaneServer } from './internal/start-http-control-plane-server.js';

/**
 * Creates a `ControlPlaneAdapter` for `NodeHttpControlPlaneNode` (`mcp.server({ port })`).
 *
 * Starts a local HTTP / `@modelcontextprotocol/sdk` listener on `127.0.0.1:node.port` exposing active run
 * inspection (`controller.getActiveRuns()`) and signal emission (`controller.emitSignal(...)`).
 *
 * @param {NodeHttpControlPlaneNode} node   - Passive HTTP control-plane AST node.
 * @param {RuntimeDriverContext}     [_ctx] - Optional runtime driver context.
 *
 * @returns {ControlPlaneAdapter} HTTP control-plane adapter.
 */
export function createNodeHttpControlPlaneAdapter(
  node: NodeHttpControlPlaneNode,
  _ctx?: RuntimeDriverContext,
): ControlPlaneAdapter {
  return Object.freeze<ControlPlaneAdapter>({
    start(controller: HarnessRuntimeController): Promise<ControlPlaneHandle> {
      return startHttpControlPlaneServer(node.port, controller);
    },
  });
}

/**
 * Creates a `ControlPlaneAdapter` for `NodeMcpSseNode` (`local.mcpSse({ port })`).
 *
 * Starts an `@modelcontextprotocol/sdk` `McpServer` over `SSEServerTransport` (`/sse` and `/messages`) on `127.0.0.1:node.port`.
 *
 * @param {NodeMcpSseNode}       node   - Passive MCP SSE control-plane AST node.
 * @param {RuntimeDriverContext} [_ctx] - Optional runtime driver context.
 *
 * @returns {ControlPlaneAdapter} MCP SSE control-plane adapter.
 */
export function createNodeMcpSseAdapter(
  node: NodeMcpSseNode,
  _ctx?: RuntimeDriverContext,
): ControlPlaneAdapter {
  return Object.freeze<ControlPlaneAdapter>({
    start(controller: HarnessRuntimeController): Promise<ControlPlaneHandle> {
      return startHttpControlPlaneServer(node.port, controller);
    },
  });
}

/**
 * Creates a `ControlPlaneAdapter` for `NodeMcpStdioNode` (`local.mcpStdio(serverName)`).
 *
 * Connects an `@modelcontextprotocol/sdk` `McpServer` to `StdioServerTransport` and detaches cleanly when `close()` is called.
 *
 * @param {NodeMcpStdioNode}     node   - Passive MCP stdio control-plane AST node.
 * @param {RuntimeDriverContext} [_ctx] - Optional runtime driver context.
 *
 * @returns {ControlPlaneAdapter} MCP stdio control-plane adapter.
 */
export function createNodeMcpStdioAdapter(
  node: NodeMcpStdioNode,
  _ctx?: RuntimeDriverContext,
): ControlPlaneAdapter {
  return Object.freeze<ControlPlaneAdapter>({
    async start(controller: HarnessRuntimeController): Promise<ControlPlaneHandle> {
      const mcpServer = buildControlPlaneMcpServer(node.serverName, controller);
      const closeStdio = await connectStdioControlPlaneTransport(mcpServer);
      return Object.freeze<ControlPlaneHandle>({
        async close(): Promise<void> {
          await closeStdio();
        },
      });
    },
  });
}
