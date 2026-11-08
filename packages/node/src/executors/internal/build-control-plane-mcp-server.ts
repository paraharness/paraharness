import { z, type HarnessRuntimeController } from '@paraharness/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Validated tool parameters for the MCP `emitSignal` (`emit_signal`) control-plane tool.
 *
 * Carries the target signal identifier and optional signal payload forwarded to `controller.emitSignal`.
 */
export interface EmitSignalToolParams {
  /** Signal identifier matching `P.signal(signalId)`. */
  readonly signalId: string;
  /** Optional payload delivered to waiting signal handlers. */
  readonly payload?: unknown;
}

/**
 * Builds an official `@modelcontextprotocol/sdk` `McpServer` bound to a `HarnessRuntimeController`.
 *
 * Registers `getActiveRuns` (`get_active_runs`) and `emitSignal` (`emit_signal`) tools so MCP clients
 * over stdio or SSE transports can inspect active runs and trigger external runtime signals.
 *
 * @param {string}                   serverName - Logical MCP server name reported in `serverInfo`.
 * @param {HarnessRuntimeController} controller - Active harness runtime controller.
 *
 * @returns {McpServer} Configured MCP server instance ready to connect to a transport.
 */
export function buildControlPlaneMcpServer(
  serverName: string,
  controller: HarnessRuntimeController,
): McpServer {
  const mcpServer = new McpServer({ name: serverName, version: '0.1.0' });
  const listRunsHandler = async (): Promise<{
    content: Array<{ type: 'text'; text: string }>;
  }> => {
    const runs = await controller.getActiveRuns();
    return { content: [{ type: 'text', text: JSON.stringify({ runs }) }] };
  };
  mcpServer.registerTool(
    'getActiveRuns',
    { description: 'List active harness runs' },
    listRunsHandler,
  );
  mcpServer.registerTool(
    'get_active_runs',
    { description: 'List active harness runs' },
    listRunsHandler,
  );
  const signalSchema = { signalId: z.string(), payload: z.unknown().optional() };
  const emitHandler = async (
    args: EmitSignalToolParams,
  ): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
    await controller.emitSignal(args.signalId, args.payload);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
  };
  mcpServer.registerTool(
    'emitSignal',
    { description: 'Emit external signal', inputSchema: signalSchema },
    emitHandler,
  );
  mcpServer.registerTool(
    'emit_signal',
    { description: 'Emit external signal', inputSchema: signalSchema },
    emitHandler,
  );
  return mcpServer;
}
