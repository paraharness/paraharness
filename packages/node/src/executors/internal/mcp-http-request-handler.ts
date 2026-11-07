import http from 'node:http';
import type { ControlPlaneHandle, HarnessRuntimeController } from '@harness-dsl/core';

/**
 * Narrowing type guard checking whether `value` is a non-null, non-array plain object record.
 *
 * Used across HTTP and stdio MCP control-plane adapters to narrow parsed JSON payloads without type casts.
 *
 * @param {unknown} value - Candidate decoded JSON value.
 *
 * @returns {value is Record<string, unknown>} True when `value` is a plain object record.
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Dispatches an inbound MCP / JSON-RPC or REST control-plane payload against `HarnessRuntimeController`.
 *
 * Supports `initialize`, `tools/list`, `tools/call` (`get_active_runs`, `emit_signal`), `runs/list`,
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
    return { jsonrpc: '2.0', id, result: { tools: [{ name: 'get_active_runs' }, { name: 'emit_signal' }] } };
  }
  const rawParams = body['params'];
  const params = isPlainRecord(rawParams) ? rawParams : body;
  const toolName = typeof params['name'] === 'string' ? params['name'] : method;
  const rawArgs = params['arguments'];
  const toolArgs = isPlainRecord(rawArgs) ? rawArgs : params;
  if (toolName === 'get_active_runs' || toolName === 'runs/list') {
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
 * Handles a single HTTP or SSE request on the control-plane server.
 *
 * Serves `GET /sse` event streams, `GET /runs` active run snapshots, and `POST` signal/JSON-RPC calls.
 *
 * @param {http.IncomingMessage}     req        - Inbound HTTP request.
 * @param {http.ServerResponse}      res        - Outbound HTTP response.
 * @param {HarnessRuntimeController} controller - Active runtime controller.
 *
 * @returns {Promise<void>} Resolves once the HTTP response is sent or initial SSE event is written.
 */
export async function handleControlPlaneHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  controller: HarnessRuntimeController,
): Promise<void> {
  const url = req.url ?? '/';
  if (req.method === 'GET' && (url.startsWith('/sse') || url.startsWith('/mcp/sse'))) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const runs = await controller.getActiveRuns();
    res.write(`event: runs\ndata: ${JSON.stringify({ runs })}\n\n`);
    return;
  }
  if (req.method === 'GET') {
    const runs = await controller.getActiveRuns();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, runs }));
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  const parsed: unknown = raw.length > 0 ? JSON.parse(raw) : {};
  const body = isPlainRecord(parsed) ? parsed : {};
  const responsePayload = await dispatchControlPlanePayload(body, controller, 'metaharness-http');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(responsePayload));
}

/**
 * Starts an HTTP listener on `127.0.0.1:port` serving MCP / REST control-plane routes.
 *
 * Tracks open SSE connections so `ControlPlaneHandle.close()` terminates all active sockets cleanly.
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
  const sseClients = new Set<http.ServerResponse>();
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'GET' && (url.startsWith('/sse') || url.startsWith('/mcp/sse'))) {
      sseClients.add(res);
      req.once('close', () => sseClients.delete(res));
    }
    void handleControlPlaneHttpRequest(req, res, controller).catch((err: unknown) => {
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
            for (const client of sseClients) client.end();
            sseClients.clear();
            await new Promise<void>((resClose) => server.close(() => resClose()));
          },
        }),
      );
    });
  });
}
