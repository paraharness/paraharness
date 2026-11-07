import type http from 'node:http';
import type { HarnessRuntimeController } from '@harness-dsl/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { buildControlPlaneMcpServer } from './build-control-plane-mcp-server.js';
import {
  dispatchControlPlaneJsonRpc,
  isPlainRecord,
} from './dispatch-control-plane-json-rpc.js';

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
 * Connects `McpServer` over `SSEServerTransport` on `GET /sse`, routes `POST /messages` to the
 * matching session's `SSEServerTransport.handlePostMessage`, and serves REST `/runs` and `/signals`.
 *
 * @param {HandleControlPlaneHttpRequestParams} params - HTTP request, response, controller, and SSE transport map.
 *
 * @returns {Promise<void>} Resolves once the HTTP response or SSE handshake completes.
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
    const mcpServer = buildControlPlaneMcpServer('metaharness-sse', controller);
    const transport = new SSEServerTransport('/messages', res);
    sseTransports.set(transport.sessionId, { mcpServer, transport });
    res.once('close', () => sseTransports.delete(transport.sessionId));
    await mcpServer.connect(transport);
    const runs = await controller.getActiveRuns();
    res.write(`event: runs\ndata: ${JSON.stringify({ runs })}\n\n`);
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
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  const parsed: unknown = raw.length > 0 ? JSON.parse(raw) : {};
  const responsePayload = await dispatchControlPlaneJsonRpc({
    body: isPlainRecord(parsed) ? parsed : {},
    controller,
    serverName: 'metaharness-http',
  });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(responsePayload));
}
