import http from 'node:http';
import type { ControlPlaneHandle, HarnessRuntimeController } from '@harness-dsl/core';

/**
 * Reads and JSON-parses the request body from an inbound `http.IncomingMessage`.
 *
 * Resolves to an empty object when the request body is empty.
 *
 * @param {http.IncomingMessage} req - Inbound HTTP request stream.
 *
 * @returns {Promise<Record<string, unknown>>} Parsed JSON object payload.
 */
export function readHttpRequestJsonBody(
  req: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.once('error', reject);
    req.once('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        resolve(typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
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
  const params = typeof body['params'] === 'object' && body['params'] !== null ? (body['params'] as Record<string, unknown>) : body;
  const toolName = typeof params['name'] === 'string' ? params['name'] : method;
  const toolArgs = typeof params['arguments'] === 'object' && params['arguments'] !== null ? (params['arguments'] as Record<string, unknown>) : params;
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
 * @param {http.IncomingMessage}      req         - Inbound HTTP request.
 * @param {http.ServerResponse}       res         - Outbound HTTP response.
 * @param {HarnessRuntimeController}  controller  - Active runtime controller.
 * @param {Set<http.ServerResponse>}  sseClients  - Set of open SSE response streams.
 *
 * @returns {Promise<void>} Resolves once the HTTP response is sent or SSE stream is registered.
 */
export async function handleControlPlaneHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  controller: HarnessRuntimeController,
  sseClients: Set<http.ServerResponse>,
): Promise<void> {
  const url = req.url ?? '/';
  if (req.method === 'GET' && (url.startsWith('/sse') || url.startsWith('/mcp/sse'))) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    sseClients.add(res);
    req.once('close', () => sseClients.delete(res));
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
  const body = await readHttpRequestJsonBody(req);
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
    void handleControlPlaneHttpRequest(req, res, controller, sseClients).catch((err: unknown) => {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
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
