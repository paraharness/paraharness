import http from 'node:http';
import type { ControlPlaneHandle, HarnessRuntimeController } from '@harness-dsl/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { buildControlPlaneMcpServer } from './mcp-server-transport-helpers.js';

/**
 * Narrowing type guard checking whether `value` is a non-null, non-array plain object record.
 *
 * Used across HTTP and SSE MCP control-plane adapters to narrow parsed JSON payloads without type casts.
 *
 * @param {unknown} value - Candidate decoded JSON value.
 *
 * @returns {value is Record<string, unknown>} True when `value` is a plain object record.
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Dispatches an inbound REST or direct JSON-RPC control-plane payload against `HarnessRuntimeController`.
 *
 * Supports `initialize`, `tools/list`, `tools/call` (`getActiveRuns`, `emitSignal`), `runs/list`,
 * and direct `{ signalId, payload }` signal emission requests.
 *
 * @param {Record<string, unknown>}  body       - Parsed request JSON payload.
 * @param {HarnessRuntimeController} controller - Active runtime controller.
 * @param {string}                   serverName - Logical MCP server name.
 *
 * @returns {Promise<Record<string, unknown>>} JSON-serializable response payload.
 */
export async function dispatchControlPlanePayload(
  body: Record<string, unknown>,
  controller: HarnessRuntimeController,
  serverName: string,
): Promise<Record<string, unknown>> {
  const id = body['id'] ?? null;
  const method = typeof body['method'] === 'string' ? body['method'] : undefined;
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: { serverInfo: { name: serverName, version: '0.1.0' } } };
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: [{ name: 'getActiveRuns' }, { name: 'emitSignal' }] } };
  }
  const rawParams = body['params'];
  const params = isPlainRecord(rawParams) ? rawParams : body;
  const toolName = typeof params['name'] === 'string' ? params['name'] : method;
  const rawArgs = params['arguments'];
  const toolArgs = isPlainRecord(rawArgs) ? rawArgs : params;
  if (toolName === 'getActiveRuns' || toolName === 'get_active_runs' || toolName === 'runs/list') {
    const runs = await controller.getActiveRuns();
    return method !== undefined ? { jsonrpc: '2.0', id, result: { runs } } : { ok: true, runs };
  }
  const signalId = typeof toolArgs['signalId'] === 'string' ? toolArgs['signalId'] : undefined;
  if (signalId !== undefined) {
    await controller.emitSignal(signalId, toolArgs['payload']);
    return method !== undefined ? { jsonrpc: '2.0', id, result: { ok: true } } : { ok: true };
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Unsupported control-plane request.' } };
}

/**
 * Handles a single HTTP or MCP `SSEServerTransport` request on the control-plane server.
 *
 * Connects `McpServer` over `SSEServerTransport` on `GET /sse`, routes `POST /messages` to the
 * matching session's `SSEServerTransport.handlePostMessage`, and serves REST `/runs` and `/signals`.
 *
 * @param {http.IncomingMessage} req   - Inbound HTTP request.
 * @param {http.ServerResponse}  res   - Outbound HTTP response.
 * @param {object}               state - Active controller and SSE transport map.
 *
 * @returns {Promise<void>} Resolves once the HTTP response or SSE handshake completes.
 */
export async function handleControlPlaneHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: {
    readonly controller: HarnessRuntimeController;
    readonly sseTransports: Map<string, { readonly mcpServer: McpServer; readonly transport: SSEServerTransport }>;
  },
): Promise<void> {
  const parsedUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method === 'GET' && (parsedUrl.pathname === '/sse' || parsedUrl.pathname === '/mcp/sse')) {
    const mcpServer = buildControlPlaneMcpServer('metaharness-sse', state.controller);
    const transport = new SSEServerTransport('/messages', res);
    state.sseTransports.set(transport.sessionId, { mcpServer, transport });
    res.once('close', () => state.sseTransports.delete(transport.sessionId));
    await mcpServer.connect(transport);
    const runs = await state.controller.getActiveRuns();
    res.write(`event: runs\ndata: ${JSON.stringify({ runs })}\n\n`);
    return;
  }
  if (req.method === 'POST' && parsedUrl.pathname === '/messages') {
    const session = state.sseTransports.get(parsedUrl.searchParams.get('sessionId') ?? '');
    if (session !== undefined) {
      await session.transport.handlePostMessage(req, res);
      return;
    }
  }
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, runs: await state.controller.getActiveRuns() }));
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  const parsed: unknown = raw.length > 0 ? JSON.parse(raw) : {};
  const responsePayload = await dispatchControlPlanePayload(isPlainRecord(parsed) ? parsed : {}, state.controller, 'metaharness-http');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(responsePayload));
}

/**
 * Starts an HTTP listener on `127.0.0.1:port` serving `@modelcontextprotocol/sdk` SSE and REST routes.
 *
 * Tracks active `McpServer` + `SSEServerTransport` sessions so `ControlPlaneHandle.close()` terminates all connections.
 *
 * @param {number}                   port       - TCP port on `127.0.0.1`.
 * @param {HarnessRuntimeController} controller - Active runtime controller.
 *
 * @returns {Promise<ControlPlaneHandle>} Active control-plane handle with deterministic `close()`.
 */
export function startHttpControlPlaneServer(
  port: number,
  controller: HarnessRuntimeController,
): Promise<ControlPlaneHandle> {
  const sseTransports = new Map<string, { readonly mcpServer: McpServer; readonly transport: SSEServerTransport }>();
  const server = http.createServer((req, res) => {
    void handleControlPlaneHttpRequest(req, res, { controller, sseTransports }).catch((err: unknown) => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      } else {
        res.end();
      }
    });
  });
  return new Promise<ControlPlaneHandle>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve(
        Object.freeze<ControlPlaneHandle>({
          async close(): Promise<void> {
            for (const entry of sseTransports.values()) await entry.mcpServer.close();
            sseTransports.clear();
            server.closeAllConnections();
            await new Promise<void>((resClose) => server.close(() => resClose()));
          },
        }),
      );
    });
  });
}
