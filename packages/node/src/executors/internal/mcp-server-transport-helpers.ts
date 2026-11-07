import { PassThrough } from 'node:stream';
import { z, type HarnessRuntimeController } from '@harness-dsl/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

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
  const listRunsHandler = async (): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
    const runs = await controller.getActiveRuns();
    return { content: [{ type: 'text', text: JSON.stringify({ runs }) }] };
  };
  mcpServer.registerTool('getActiveRuns', { description: 'List active harness runs' }, listRunsHandler);
  mcpServer.registerTool('get_active_runs', { description: 'List active harness runs' }, listRunsHandler);
  const signalSchema = { signalId: z.string(), payload: z.unknown().optional() };
  const emitHandler = async (args: {
    signalId: string;
    payload?: unknown;
  }): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
    await controller.emitSignal(args.signalId, args.payload);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
  };
  mcpServer.registerTool('emitSignal', { description: 'Emit external signal', inputSchema: signalSchema }, emitHandler);
  mcpServer.registerTool('emit_signal', { description: 'Emit external signal', inputSchema: signalSchema }, emitHandler);
  return mcpServer;
}

/**
 * Normalizes a single line of inbound stdio JSON-RPC text into a Buffer for `StdioServerTransport`.
 *
 * Emits a JSON-RPC `-32700` parse error to `process.stdout` when `line` is not valid JSON and injects
 * default MCP `initialize` parameters when omitted by lightweight JSON-RPC callers.
 *
 * @param {string}      line            - Trimmed single-line JSON-RPC payload.
 * @param {PassThrough} normalizedStdin - Buffer-only stream feeding `StdioServerTransport`.
 */
export function forwardNormalizedStdioLine(line: string, normalizedStdin: PassThrough): void {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new SyntaxError('Expected JSON-RPC object');
    }
    const record = parsed as Record<string, unknown>;
    if (record['method'] === 'initialize' && typeof record['params'] !== 'object') {
      const normalized = {
        ...record,
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'stdio-client', version: '0.1.0' },
        },
      };
      normalizedStdin.write(Buffer.from(`${JSON.stringify(normalized)}\n`, 'utf8'));
      return;
    }
    normalizedStdin.write(Buffer.from(`${JSON.stringify(record)}\n`, 'utf8'));
  } catch {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`,
    );
  }
}

/**
 * Connects a `StdioServerTransport` to `mcpServer` with Buffer-normalized `process.stdin` framing.
 *
 * Prevents `@modelcontextprotocol/sdk` `ReadBuffer` from receiving raw string chunks (which lack `.subarray`)
 * while routing all valid JSON-RPC messages through `StdioServerTransport` and `McpServer`.
 *
 * @param {McpServer} mcpServer - Configured MCP server instance.
 *
 * @returns {Promise<() => Promise<void>>} Teardown callback detaching `process.stdin` and closing `mcpServer`.
 */
export async function connectStdioControlPlaneTransport(
  mcpServer: McpServer,
): Promise<() => Promise<void>> {
  const normalizedStdin = new PassThrough();
  const transport = new StdioServerTransport(normalizedStdin, process.stdout);
  await mcpServer.connect(transport);
  let lineBuffer = '';
  const onData = (chunk: Buffer | string): void => {
    lineBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let newlineIdx = lineBuffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const line = lineBuffer.slice(0, newlineIdx).trim();
      lineBuffer = lineBuffer.slice(newlineIdx + 1);
      newlineIdx = lineBuffer.indexOf('\n');
      if (line.length > 0) forwardNormalizedStdioLine(line, normalizedStdin);
    }
  };
  process.stdin.on('data', onData);
  process.stdin.unref?.();
  return async (): Promise<void> => {
    process.stdin.removeListener('data', onData);
    if (process.stdin.listenerCount('data') === 0) process.stdin.pause();
    normalizedStdin.end();
    await mcpServer.close();
  };
}
