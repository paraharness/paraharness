import http from 'node:http';
import type { ControlPlaneHandle, HarnessRuntimeController } from '@harness-dsl/core';
import {
  handleControlPlaneHttpRequest,
  type ControlPlaneSseSessionEntry,
} from './handle-control-plane-http-request.js';

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
  const sseTransports = new Map<string, ControlPlaneSseSessionEntry>();
  const server = http.createServer((req, res) => {
    void handleControlPlaneHttpRequest({ req, res, controller, sseTransports }).catch(
      (err: unknown) => {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end(
            JSON.stringify({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        } else {
          res.end();
        }
      },
    );
  });
  return new Promise<ControlPlaneHandle>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve(
        Object.freeze<ControlPlaneHandle>({
          async close(): Promise<void> {
            for (const entry of sseTransports.values()) {
              await entry.mcpServer.close();
            }
            sseTransports.clear();
            server.closeAllConnections();
            await new Promise<void>((resClose) => server.close(() => resClose()));
          },
        }),
      );
    });
  });
}
