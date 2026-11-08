import type http from 'node:http';
import type { HarnessRuntimeController } from '@paraharness/core';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { buildControlPlaneMcpServer } from './build-control-plane-mcp-server.js';
import type { ControlPlaneSseSessionEntry } from './handle-control-plane-http-request.js';

/**
 * Parameters for establishing an MCP `SSEServerTransport` control-plane session over HTTP.
 *
 * Supplies the outbound HTTP response stream, the runtime controller, and the active SSE session registry.
 */
export interface ConnectSseControlPlaneSessionParams {
  /** Outbound HTTP response used as the SSE stream. */
  readonly res: http.ServerResponse;
  /** Active harness runtime controller. */
  readonly controller: HarnessRuntimeController;
  /** Map of active SSE session IDs to their `McpServer` and `SSEServerTransport` instances. */
  readonly sseTransports: Map<string, ControlPlaneSseSessionEntry>;
}

/**
 * Connects an `@modelcontextprotocol/sdk` `McpServer` to an `SSEServerTransport` and emits the initial `runs` event.
 *
 * Registers the session in `sseTransports` and removes it automatically when the response stream closes.
 *
 * @param {ConnectSseControlPlaneSessionParams} params - HTTP response, runtime controller, and active SSE session map.
 *
 * @returns {Promise<void>} Resolves once the SSE transport handshake and initial `runs` frame are written.
 *
 * @throws {Error} If connecting the `McpServer` or querying active runs fails.
 */
export async function connectSseControlPlaneSession(
  params: ConnectSseControlPlaneSessionParams,
): Promise<void> {
  const { res, controller, sseTransports } = params;
  const mcpServer = buildControlPlaneMcpServer('metaharness-sse', controller);
  const transport = new SSEServerTransport('/messages', res);
  sseTransports.set(transport.sessionId, { mcpServer, transport });
  res.once('close', () => sseTransports.delete(transport.sessionId));
  await mcpServer.connect(transport);
  const runs = await controller.getActiveRuns();
  res.write(`event: runs\ndata: ${JSON.stringify({ runs })}\n\n`);
}
