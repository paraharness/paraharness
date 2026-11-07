import type {
  ControlPlaneAdapter,
  ControlPlaneHandle,
  HarnessRuntimeController,
  NodeHttpControlPlaneNode,
  NodeMcpSseNode,
  NodeMcpStdioNode,
  RuntimeDriverContext,
} from '@harness-dsl/core';
import {
  dispatchControlPlanePayload,
  isPlainRecord,
  startHttpControlPlaneServer,
} from './internal/mcp-http-request-handler.js';

/**
 * Creates a `ControlPlaneAdapter` for `NodeHttpControlPlaneNode` (`mcp.server({ port })`).
 *
 * Starts a local HTTP / MCP JSON-RPC listener on `127.0.0.1:node.port` exposing active run
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
 * Starts a local HTTP Server-Sent Events (`/sse`) and JSON-RPC message listener on `127.0.0.1:node.port`.
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
 * Processes line-delimited JSON-RPC 2.0 control-plane messages and detaches cleanly when `close()` is called.
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
    start(controller: HarnessRuntimeController): Promise<ControlPlaneHandle> {
      let buffer = '';
      const onData = (chunk: Buffer | string): void => {
        buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        let newlineIdx = buffer.indexOf('\n');
        while (newlineIdx !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          newlineIdx = buffer.indexOf('\n');
          if (line.length === 0) continue;
          try {
            const parsed: unknown = JSON.parse(line);
            if (!isPlainRecord(parsed)) throw new Error('Invalid JSON-RPC request');
            void dispatchControlPlanePayload(parsed, controller, node.serverName)
              .then((resp) => process.stdout.write(`${JSON.stringify(resp)}\n`))
              .catch((err: unknown) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: parsed['id'] ?? null, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } })}\n`));
          } catch {
            process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
          }
        }
      };
      process.stdin.on('data', onData);
      process.stdin.unref?.();
      return Promise.resolve(Object.freeze<ControlPlaneHandle>({
        close(): Promise<void> {
          process.stdin.removeListener('data', onData);
          process.stdin.pause();
          return Promise.resolve();
        },
      }));
    },
  });
}
