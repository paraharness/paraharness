import type http from 'node:http';
import type { HarnessRuntimeController } from '@paraharness/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { connectSseControlPlaneSession } from './connect-sse-control-plane-session.js';
import {
  dispatchControlPlaneJsonRpc,
  isPlainRecord,
} from './dispatch-control-plane-json-rpc.js';
import { readControlPlaneRequestJson } from './read-control-plane-request-json.js';

/**
 * Active MCP `SSEServerTransport` session entry tracked by an HTTP control-plane listener.
 *
 * Pairs the connected `McpServer` instance with its underlying `SSEServerTransport`.
 */
export interface ControlPlaneSseSessionEntry {
  /** Connected MCP server instance for this SSE session. */
  readonly mcpServer: McpServer;
  /** Active SSE transport handling `/sse` and `/messages` for this session. */
  readonly transport: SSEServerTransport;
}

/**
 * Parameters for handling a single HTTP or MCP `SSEServerTransport` request on the control-plane server.
 *
 * Supplies the inbound request, outbound response, runtime controller, and active SSE session map.
 */
export interface HandleControlPlaneHttpRequestParams {
  /** Inbound HTTP request. */
  readonly req: http.IncomingMessage;
  /** Outbound HTTP response. */
  readonly res: http.ServerResponse;
  /** Active harness runtime controller. */
  readonly controller: HarnessRuntimeController;
  /** Map of active SSE session IDs to their `McpServer` and `SSEServerTransport` instances. */
  readonly sseTransports: Map<string, ControlPlaneSseSessionEntry>;
}

/**
 * Handles a single HTTP or MCP `SSEServerTransport` request on the control-plane server.
 *
 * Routes `GET /sse` to `connectSseControlPlaneSession`, `POST /messages` to the matching session's
 * `SSEServerTransport.handlePostMessage`, `GET` requests to active run status, and `POST` payloads
 * through `readControlPlaneRequestJson` and `dispatchControlPlaneJsonRpc`.
 *
 * @param {HandleControlPlaneHttpRequestParams} params - HTTP request, response, controller, and SSE transport map.
 *
 * @returns {Promise<void>} Resolves once the HTTP response or SSE handshake completes.
 *
 * @throws {Error} If request body parsing, SSE session connection, or JSON-RPC dispatch fails.
 */
export async function handleControlPlaneHttpRequest(
  params: HandleControlPlaneHttpRequestParams,
): Promise<void> {
  const { req, res, controller, sseTransports } = params;
  const parsedUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (
    req.method === 'GET' &&
    (parsedUrl.pathname === '/sse' || parsedUrl.pathname === '/mcp/sse')
  ) {
    await connectSseControlPlaneSession({ res, controller, sseTransports });
    return;
  }
  if (req.method === 'POST' && parsedUrl.pathname === '/messages') {
    const session = sseTransports.get(parsedUrl.searchParams.get('sessionId') ?? '');
    if (session !== undefined) {
      await session.transport.handlePostMessage(req, res);
      return;
    }
  }
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, runs: await controller.getActiveRuns() }));
    return;
  }
  const parsed = await readControlPlaneRequestJson(req);
  const responsePayload = await dispatchControlPlaneJsonRpc({
    body: isPlainRecord(parsed) ? parsed : {},
    controller,
    serverName: 'metaharness-http',
  });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(responsePayload));
}
